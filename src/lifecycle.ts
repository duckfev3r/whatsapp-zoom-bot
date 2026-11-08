import {
  allowlistMatches,
  type Command,
  jidKey,
  parseCommand,
  type Sender,
  sameSender,
} from "./commands.js";
import type { InboxRow, InstanceRow, MeetingRow, Store } from "./db.js";
import { generateHostKey, generatePasscode } from "./hostkey.js";
import * as msg from "./messages.js";
import type { Summarizer } from "./summary.js";
import { vttToText } from "./transcript.js";
import type { ChatPort, IncomingMessage, MsgKey, QuoteRef } from "./whatsapp/types.js";
import type { RecordingFile, ZoomApi } from "./zoom/client.js";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export interface BotSettings {
  groupJids: string[];
  allowlist: string[];
  allowGroupAdmins: boolean;
  hostKeyRotation: boolean;
  defaultTitle: string;
  pinSeconds: 86400 | 604800 | 2592000;
  expireAfterMinutes: number;
  minInstanceMinutes: number;
  transcriptGiveUpHours: number;
  retentionDays: number;
  deleteAction: "delete" | "trash";
  timezone: string;
  /** Attempts before a stored webhook is dropped. */
  maxInboxAttempts: number;
}

export const defaultSettings: BotSettings = {
  groupJids: [],
  allowlist: [],
  allowGroupAdmins: true,
  hostKeyRotation: true,
  defaultTitle: "Group call",
  pinSeconds: 86400,
  expireAfterMinutes: 120,
  minInstanceMinutes: 2,
  transcriptGiveUpHours: 24,
  retentionDays: 7,
  deleteAction: "delete",
  timezone: "Europe/Dublin",
  maxInboxAttempts: 5,
};

export interface BotDeps {
  store: Store;
  zoom: ZoomApi;
  chat: ChatPort;
  summarizer: Summarizer | null;
  log: Logger;
  settings?: Partial<BotSettings>;
  now?: () => Date;
}

/** The Zoom webhook events the bot acts on. */
export const HANDLED_EVENTS = [
  "meeting.started",
  "meeting.ended",
  "recording.transcript_completed",
] as const;

export interface ZoomEventBody {
  event: string;
  payload?: {
    download_token?: string;
    object?: {
      id?: string | number;
      uuid?: string;
      start_time?: string;
      end_time?: string;
      recording_files?: {
        file_type?: string;
        status?: string;
        download_url?: string;
      }[];
    };
  };
  download_token?: string;
}

/** Idempotency key for a webhook: event type plus instance UUID. */
export function webhookKey(body: ZoomEventBody): string | null {
  const uuid = body.payload?.object?.uuid;
  return uuid ? `${body.event}:${uuid}` : null;
}

/**
 * The lifecycle core. Every command, webhook and sweep runs through one queue, so the
 * state machine never sees two changes at once.
 */
export class Bot {
  readonly settings: BotSettings;
  private readonly store: Store;
  private readonly zoom: ZoomApi;
  private readonly chat: ChatPort;
  private readonly summarizer: Summarizer | null;
  private readonly log: Logger;
  private readonly now: () => Date;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: BotDeps) {
    this.store = deps.store;
    this.zoom = deps.zoom;
    this.chat = deps.chat;
    this.summarizer = deps.summarizer;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
    this.settings = { ...defaultSettings, ...deps.settings };
  }

  /** Runs `fn` after everything queued before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- commands

  handleMessage(m: IncomingMessage): Promise<void> {
    const cmd = parseCommand(m.text);
    if (!cmd) return Promise.resolve();
    if (this.settings.groupJids.length && !this.settings.groupJids.includes(m.groupJid)) {
      this.log.info({ group: m.groupJid }, "ignoring /zoom from a group not in GROUP_JIDS");
      return Promise.resolve();
    }
    return this.serial(() => this.runCommand(cmd, m));
  }

  private async runCommand(cmd: Command, m: IncomingMessage): Promise<void> {
    const reply = (text: string) => this.chat.sendText(m.groupJid, text, { quote: m.quote });
    switch (cmd.kind) {
      case "help":
        await reply(msg.HELP);
        return;
      case "status":
        await reply(this.statusText(m.groupJid));
        return;
      case "start":
        await this.start(m, cmd.record, cmd.title ?? this.settings.defaultTitle);
        return;
      case "end":
        await this.end(m);
        return;
    }
  }

  private statusText(groupJid: string): string {
    const active = this.store.activeMeeting(groupJid);
    if (!active) return msg.NO_MEETING;
    const live = active.status === "live";
    const at = live ? (active.started_at ?? active.created_at) : active.created_at;
    return msg.status({
      live,
      title: active.title ?? this.settings.defaultTitle,
      name: active.requester_name ?? "someone",
      at: this.formatTime(at),
      joinUrl: active.join_url,
    });
  }

  formatTime(isoTime: string): string {
    return new Intl.DateTimeFormat("en-IE", {
      timeZone: this.settings.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(isoTime));
  }

  private async isAllowed(groupJid: string, sender: Sender): Promise<boolean> {
    if (allowlistMatches(this.settings.allowlist, sender)) return true;
    if (!this.settings.allowGroupAdmins) return false;
    return this.isAdmin(groupJid, sender);
  }

  private async isAdmin(groupJid: string, sender: Sender): Promise<boolean> {
    try {
      return await this.chat.isGroupAdmin(groupJid, sender);
    } catch (err) {
      this.log.warn({ err, group: groupJid }, "couldn't read group admins");
      return false;
    }
  }

  private async start(m: IncomingMessage, record: boolean, title: string): Promise<void> {
    const reply = (text: string) => this.chat.sendText(m.groupJid, text, { quote: m.quote });

    if (!(await this.isAllowed(m.groupJid, m.sender))) {
      const key = `noallow:${m.groupJid}:${jidKey(m.sender.alt ?? m.sender.jid)}`;
      if (this.store.claimNotice(key, this.iso())) await reply(msg.NOT_ALLOWED);
      return;
    }

    const here = this.store.activeMeeting(m.groupJid);
    if (here) {
      await this.chat.sendText(m.groupJid, `${msg.ALREADY_ACTIVE} ${here.join_url}`, {
        quote: this.createQuote(here),
      });
      return;
    }
    if (this.store.activeMeetings().length > 0) {
      await reply(msg.HOST_BUSY);
      return;
    }

    let created: { id: string; joinUrl: string };
    try {
      created = await this.zoom.createMeeting({
        topic: title,
        record,
        passcode: generatePasscode(),
      });
    } catch (err) {
      this.log.error({ err }, "create meeting failed");
      await reply(msg.CREATE_FAILED);
      return;
    }

    // Rotate the host key now, while no other meeting is live. Kept in memory only.
    let hostKey: string | null = null;
    if (this.settings.hostKeyRotation) {
      const candidate = generateHostKey();
      try {
        await this.zoom.setHostKey(candidate);
        hostKey = candidate;
      } catch (err) {
        this.log.warn({ err: String(err) }, "host key rotation failed; not sending a key");
      }
    }

    const name = m.sender.name ?? "someone";
    const text = msg.created({ title, joinUrl: created.joinUrl, name, record });
    let key: MsgKey;
    try {
      key = await this.chat.sendText(m.groupJid, text);
    } catch (err) {
      this.log.error({ err }, "couldn't post the meeting link; deleting the meeting");
      await this.zoom.deleteMeeting(created.id).catch(() => undefined);
      throw err;
    }

    this.store.insertMeeting({
      zoom_meeting_id: created.id,
      group_jid: m.groupJid,
      title,
      join_url: created.joinUrl,
      record: record ? 1 : 0,
      requested_by: m.sender.jid,
      requester_alt: m.sender.alt ?? null,
      requester_name: m.sender.name ?? null,
      wa_msg_key: JSON.stringify(key),
      created_at: this.iso(),
    });
    this.log.info({ zoomId: created.id, group: m.groupJid }, "meeting created");

    if (this.settings.hostKeyRotation) {
      const dm = hostKey ? msg.hostKeyDm(title, hostKey) : msg.hostKeyUnavailable(title);
      await this.chat
        .sendText(m.sender.alt ?? m.sender.jid, dm)
        .catch((err) => this.log.warn({ err }, "couldn't DM the requester"));
    }
  }

  private async end(m: IncomingMessage): Promise<void> {
    const reply = (text: string) => this.chat.sendText(m.groupJid, text, { quote: m.quote });
    const active = this.store.activeMeeting(m.groupJid);
    if (!active) {
      await reply(msg.NO_MEETING);
      return;
    }
    const isRequester = sameSender(m.sender, {
      jid: active.requested_by,
      alt: active.requester_alt,
    });
    if (!isRequester && !(await this.isAdmin(m.groupJid, m.sender))) {
      await reply(msg.onlyRequesterCanEnd(active.requester_name ?? "the person who started it"));
      return;
    }
    if (active.status === "created") {
      await this.zoom.deleteMeeting(active.zoom_meeting_id).catch((err) => {
        this.log.warn({ err }, "delete meeting failed");
      });
      this.store.setStatus(active.id, "expired", { ended_at: this.iso() });
      await reply(msg.CANCELLED);
      return;
    }
    try {
      await this.zoom.endMeeting(active.zoom_meeting_id);
      await reply(msg.ENDING);
    } catch (err) {
      this.log.error({ err }, "end meeting failed");
      await reply(msg.END_FAILED);
    }
    // meeting.ended (or the sweeper) unpins and posts the end message.
  }

  private createQuote(m: MeetingRow): QuoteRef {
    return {
      key: JSON.parse(m.wa_msg_key) as MsgKey,
      text: msg.created({
        title: m.title ?? this.settings.defaultTitle,
        joinUrl: m.join_url,
        name: m.requester_name ?? "someone",
        record: m.record === 1,
      }),
    };
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * Stores a verified webhook and processes the queue. Returns false for a duplicate.
   * Events are handled in the order they arrived, including after a restart.
   */
  async receiveWebhook(body: ZoomEventBody): Promise<boolean> {
    const key = webhookKey(body);
    if (!key || !(HANDLED_EVENTS as readonly string[]).includes(body.event)) return false;
    const fresh = this.store.enqueue(key, body.event, JSON.stringify(body), this.iso());
    if (!fresh) {
      this.log.info({ key }, "duplicate webhook ignored");
      return false;
    }
    void this.drainInbox();
    return true;
  }

  /** Handles stored webhooks in order. Stops at the first failure and retries later. */
  drainInbox(): Promise<void> {
    return this.serial(async () => {
      for (;;) {
        const row = this.store.nextInbox();
        if (!row) return;
        try {
          await this.handleEvent(row);
          this.store.markInbox(row.id, this.iso());
        } catch (err) {
          const attempts = this.store.failInbox(row.id, String(err));
          this.log.error({ err, key: row.key, attempts }, "webhook handling failed");
          if (attempts >= this.settings.maxInboxAttempts) {
            this.store.markInbox(row.id, this.iso(), `gave up: ${String(err)}`);
            continue;
          }
          return; // keep order: retry this one on the next drain
        }
      }
    });
  }

  private async handleEvent(row: InboxRow): Promise<void> {
    const body = JSON.parse(row.body) as ZoomEventBody;
    const obj = body.payload?.object ?? {};
    const zoomId = obj.id === undefined ? undefined : String(obj.id);
    const uuid = obj.uuid as string;
    switch (row.event) {
      case "meeting.started":
        if (zoomId) await this.onStarted(zoomId, uuid, obj.start_time ?? row.received_at);
        return;
      case "meeting.ended":
        if (zoomId) {
          await this.onEnded(zoomId, uuid, obj.start_time ?? null, obj.end_time ?? row.received_at);
        }
        return;
      case "recording.transcript_completed": {
        const files: RecordingFile[] = (obj.recording_files ?? [])
          .filter((f) => f.download_url)
          .map((f) => ({
            fileType: f.file_type ?? "",
            status: f.status,
            downloadUrl: f.download_url as string,
          }));
        const token = body.download_token ?? body.payload?.download_token;
        await this.onTranscript(zoomId, uuid, files, token);
        return;
      }
    }
  }

  private async onStarted(zoomId: string, uuid: string, startedAt: string): Promise<void> {
    const meeting = this.store.meetingByZoomId(zoomId);
    if (!meeting || meeting.status === "expired") return;
    const inserted = this.store.addInstance(uuid, meeting.id, startedAt);
    if (!inserted && meeting.status === "live") return;
    // created -> live, ended -> live (rejoin). A rejoin after done reopens it too.
    this.store.setStatus(meeting.id, "live");
    this.store.setStartedIfUnset(meeting.id, startedAt);
    await this.pin(meeting);
  }

  private async pin(meeting: MeetingRow): Promise<void> {
    const noticeKey = `pinadmin:${meeting.group_jid}`;
    try {
      await this.chat.pin(
        meeting.group_jid,
        JSON.parse(meeting.wa_msg_key) as MsgKey,
        this.settings.pinSeconds,
      );
      this.store.clearNotice(noticeKey);
    } catch (err) {
      this.log.warn({ err: String(err) }, "pin failed");
      if (this.store.claimNotice(noticeKey, this.iso())) {
        await this.chat.sendText(meeting.group_jid, msg.MAKE_ME_ADMIN).catch((e) => {
          this.store.clearNotice(noticeKey); // try again next time
          this.log.warn({ err: String(e) }, "couldn't send the admin notice");
        });
      }
    }
  }

  private async onEnded(
    zoomId: string,
    uuid: string,
    startedAt: string | null,
    endedAt: string,
  ): Promise<void> {
    const meeting = this.store.meetingByZoomId(zoomId);
    if (!meeting || meeting.status === "expired") return;
    await this.endInstance(meeting, uuid, startedAt, endedAt);
  }

  private isShort(inst: InstanceRow): boolean {
    if (!inst.started_at || !inst.ended_at) return false;
    const ms = Date.parse(inst.ended_at) - Date.parse(inst.started_at);
    return ms < this.settings.minInstanceMinutes * 60_000;
  }

  /** live -> ended for one instance. Safe to call twice. */
  private async endInstance(
    meeting: MeetingRow,
    uuid: string,
    startedAt: string | null,
    endedAt: string,
  ): Promise<void> {
    this.store.addInstance(uuid, meeting.id, startedAt);
    const inst = this.store.instance(uuid) as InstanceRow;
    if (inst.ended_at) return;

    const short = this.isShort({ ...inst, ended_at: endedAt });
    const othersOpen = this.store.openInstances(meeting.id).some((i) => i.uuid !== uuid);
    const closes = !othersOpen && (meeting.status === "live" || meeting.status === "created");

    // Talk to WhatsApp first. If that throws, nothing is saved and the event is retried.
    if (closes) {
      await this.chat
        .unpin(meeting.group_jid, JSON.parse(meeting.wa_msg_key) as MsgKey)
        .catch((err) => this.log.warn({ err: String(err) }, "unpin failed"));
      const durationMs = inst.started_at ? Date.parse(endedAt) - Date.parse(inst.started_at) : 0;
      const note = meeting.record !== 1 ? "none" : short ? "short" : "transcript";
      await this.chat.sendText(meeting.group_jid, msg.ended({ durationMs, note }));
    }

    this.store.db.transaction(() => {
      this.store.setInstanceEnded(uuid, endedAt);
      if (meeting.record !== 1) this.store.setOutcome(uuid, "norecord");
      else if (short) this.store.setOutcome(uuid, "short");
      if (closes) this.store.setStatus(meeting.id, "ended", { ended_at: endedAt });
    })();
    this.completeIfDone(meeting.id);
  }

  private async onTranscript(
    zoomId: string | undefined,
    uuid: string,
    files: RecordingFile[],
    token: string | undefined,
  ): Promise<void> {
    let inst = this.store.instance(uuid);
    if (!inst) {
      const meeting = zoomId ? this.store.meetingByZoomId(zoomId) : undefined;
      if (!meeting) return;
      this.store.addInstance(uuid, meeting.id, null);
      this.store.setInstanceEnded(uuid, this.iso());
      inst = this.store.instance(uuid) as InstanceRow;
    }
    if (inst.outcome) return;
    const file = files.find((f) => f.fileType.toUpperCase() === "TRANSCRIPT");
    if (!file) return; // the sweeper will look again
    const vtt = await this.zoom.downloadText(file.downloadUrl, token);
    await this.deliverTranscript(inst, vtt);
  }

  private partNumber(inst: InstanceRow): number | null {
    const kept = this.store
      .instances(inst.meeting_id)
      .filter((i) => i.outcome !== "short" && !this.isShort(i));
    if (kept.length < 2) return null;
    const idx = kept.findIndex((i) => i.uuid === inst.uuid);
    return idx === -1 ? null : idx + 1;
  }

  private async deliverTranscript(inst: InstanceRow, vtt: string): Promise<void> {
    const meeting = this.store.meeting(inst.meeting_id) as MeetingRow;
    const title = meeting.title ?? this.settings.defaultTitle;
    const part = this.partNumber(inst);
    const text = vttToText(vtt);
    if (!text) {
      this.store.setOutcome(inst.uuid, "missing");
      await this.chat.sendText(meeting.group_jid, msg.noTranscript(title, part));
      this.completeIfDone(meeting.id);
      return;
    }

    let summary: string | null = null;
    let summaryFailed = false;
    if (this.summarizer) {
      try {
        summary = await this.summarizer.summarize({ title, transcript: text });
        summaryFailed = summary === null;
      } catch (err) {
        this.log.error({ err: String(err) }, "summary failed; posting transcript only");
        summaryFailed = true;
      }
    }

    const day = (inst.started_at ?? inst.ended_at ?? this.iso()).slice(0, 10);
    const header = [title, part ? `Part ${part}` : null, day].filter(Boolean).join(" — ");
    await this.chat.sendDocument(
      meeting.group_jid,
      {
        data: Buffer.from(`${header}\n\n${text}\n`, "utf8"),
        fileName: transcriptFileName(title, day, part),
        mimetype: "text/plain",
        caption: msg.transcriptCaption({ title, part, summary, summaryFailed }),
      },
      { quote: this.createQuote(meeting) },
    );
    this.store.setOutcome(inst.uuid, "posted", this.iso());
    this.log.info({ uuid: inst.uuid }, "transcript posted");
    this.completeIfDone(meeting.id);
  }

  /** ended -> done once every instance has an outcome. */
  private completeIfDone(meetingId: number): void {
    const meeting = this.store.meeting(meetingId);
    if (meeting?.status !== "ended") return;
    const all = this.store.instances(meetingId);
    if (all.every((i) => i.outcome !== null)) this.store.setStatus(meetingId, "done");
  }

  // ---------------------------------------------------------------- sweepers

  /**
   * Every 15 minutes: expires unused links after 2h, and asks Zoom about every open
   * meeting to catch a missed meeting.started or meeting.ended.
   */
  sweepMeetings(): Promise<void> {
    return this.serial(async () => {
      const now = this.now().getTime();
      for (const meeting of this.store.activeMeetings()) {
        let info: Awaited<ReturnType<ZoomApi["meetingStatus"]>>;
        try {
          info = await this.zoom.meetingStatus(meeting.zoom_meeting_id);
        } catch (err) {
          this.log.warn(
            { err: String(err), zoomId: meeting.zoom_meeting_id },
            "status check failed",
          );
          continue;
        }
        if (meeting.status === "created") {
          if (info.status === "started" && info.uuid) {
            await this.onStarted(meeting.zoom_meeting_id, info.uuid, info.startTime ?? this.iso());
            continue;
          }
          const age = now - Date.parse(meeting.created_at);
          if (age >= this.settings.expireAfterMinutes * 60_000) await this.expire(meeting);
          continue;
        }
        // live
        if (info.status === "started") continue;
        const open = this.store.openInstances(meeting.id);
        if (open.length === 0) {
          this.store.setStatus(meeting.id, "ended", { ended_at: this.iso() });
          this.completeIfDone(meeting.id);
          continue;
        }
        for (const inst of open) await this.endInstance(meeting, inst.uuid, null, this.iso());
      }
    });
  }

  private async expire(meeting: MeetingRow): Promise<void> {
    await this.zoom.deleteMeeting(meeting.zoom_meeting_id).catch((err) => {
      this.log.warn({ err: String(err) }, "delete expired meeting failed");
    });
    // Reply first: if WhatsApp is down, the next sweep tries again.
    await this.chat.sendText(meeting.group_jid, msg.EXPIRED, { quote: this.createQuote(meeting) });
    this.store.setStatus(meeting.id, "expired", { ended_at: this.iso() });
  }

  /**
   * Every 30 minutes: polls Zoom for instances that ended without a transcript.
   * Gives up after 24h and says so in the group.
   */
  sweepTranscripts(): Promise<void> {
    return this.serial(async () => {
      const now = this.now().getTime();
      const giveUpMs = this.settings.transcriptGiveUpHours * 3_600_000;
      for (const inst of this.store.pendingTranscripts()) {
        const meeting = this.store.meeting(inst.meeting_id) as MeetingRow;
        if (now - Date.parse(inst.ended_at as string) >= giveUpMs) {
          this.store.setOutcome(inst.uuid, "missing");
          const title = meeting.title ?? this.settings.defaultTitle;
          await this.chat.sendText(
            meeting.group_jid,
            msg.noTranscript(title, this.partNumber(inst)),
          );
          this.completeIfDone(meeting.id);
          continue;
        }
        this.store.bumpAttempts(inst.uuid);
        try {
          const files = await this.zoom.listRecordings(inst.uuid);
          const file = files?.find(
            (f) =>
              f.fileType.toUpperCase() === "TRANSCRIPT" &&
              (!f.status || f.status.toLowerCase() === "completed"),
          );
          if (!file) continue;
          const vtt = await this.zoom.downloadText(file.downloadUrl);
          await this.deliverTranscript(inst, vtt);
        } catch (err) {
          this.log.warn({ err: String(err), uuid: inst.uuid }, "transcript poll failed");
        }
      }
      for (const m of this.store.meetingsWithStatus("ended")) this.completeIfDone(m.id);
    });
  }

  /** Hourly: deletes Zoom cloud recordings once they are past the retention period. */
  sweepRetention(): Promise<void> {
    return this.serial(async () => {
      const cutoff = new Date(this.now().getTime() - this.settings.retentionDays * 86_400_000);
      for (const inst of this.store.recordingsDue(cutoff.toISOString())) {
        try {
          await this.zoom.deleteRecordings(inst.uuid, this.settings.deleteAction);
          this.store.setRecordingDeleted(inst.uuid, this.iso());
          this.log.info({ uuid: inst.uuid }, "cloud recording deleted");
        } catch (err) {
          this.log.warn({ err: String(err), uuid: inst.uuid }, "recording delete failed");
        }
      }
      const week = new Date(this.now().getTime() - 7 * 86_400_000);
      this.store.pruneInbox(week.toISOString());
    });
  }

  /** Waits for everything queued so far. Used by tests and shutdown. */
  idle(): Promise<void> {
    return this.serial(async () => undefined);
  }
}

export function transcriptFileName(title: string, day: string, part: number | null): string {
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "meeting";
  return `${slug}-${day}${part ? `-part-${part}` : ""}.txt`;
}
