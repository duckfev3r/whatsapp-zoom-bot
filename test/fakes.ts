import type { Sender } from "../src/commands.js";
import { jidKey } from "../src/commands.js";
import { Store } from "../src/db.js";
import { Bot, type BotSettings, type ZoomEventBody } from "../src/lifecycle.js";
import type { Summarizer } from "../src/summary.js";
import type {
  ChatPort,
  IncomingMessage,
  MsgKey,
  OutgoingDocument,
  QuoteRef,
} from "../src/whatsapp/types.js";
import type {
  CreatedMeeting,
  MeetingStatusInfo,
  RecordingFile,
  ZoomApi,
} from "../src/zoom/client.js";

export interface Sent {
  jid: string;
  text: string;
  key: MsgKey;
  quote?: QuoteRef;
  doc?: OutgoingDocument;
}

export class FakeChat implements ChatPort {
  sent: Sent[] = [];
  pins: { group: string; key: MsgKey; seconds: number }[] = [];
  unpins: { group: string; key: MsgKey }[] = [];
  admins = new Set<string>();
  botIsAdmin = true;
  failNextSend = 0;
  private n = 0;

  async sendText(jid: string, text: string, opts?: { quote?: QuoteRef }): Promise<MsgKey> {
    if (this.failNextSend > 0) {
      this.failNextSend--;
      throw new Error("socket closed");
    }
    const key = { id: `MSG${++this.n}`, remoteJid: jid, fromMe: true };
    this.sent.push({ jid, text, key, quote: opts?.quote });
    return key;
  }

  async sendDocument(
    jid: string,
    doc: OutgoingDocument,
    opts?: { quote?: QuoteRef },
  ): Promise<MsgKey> {
    const key = { id: `MSG${++this.n}`, remoteJid: jid, fromMe: true };
    this.sent.push({ jid, text: doc.caption ?? "", key, quote: opts?.quote, doc });
    return key;
  }

  async pin(group: string, key: MsgKey, seconds: number): Promise<void> {
    if (!this.botIsAdmin) throw new Error("not admin");
    this.pins.push({ group, key, seconds });
  }

  async unpin(group: string, key: MsgKey): Promise<void> {
    this.unpins.push({ group, key });
  }

  async isGroupAdmin(_group: string, sender: Sender): Promise<boolean> {
    return [sender.jid, sender.alt].some((j) => j && this.admins.has(jidKey(j)));
  }

  textsTo(jid: string): string[] {
    return this.sent.filter((s) => s.jid === jid).map((s) => s.text);
  }

  last(jid?: string): Sent | undefined {
    return (jid ? this.sent.filter((s) => s.jid === jid) : this.sent).at(-1);
  }
}

export class FakeZoom implements ZoomApi {
  created: { topic: string; record: boolean; passcode: string }[] = [];
  ended: string[] = [];
  deleted: string[] = [];
  hostKeys: string[] = [];
  deletedRecordings: { uuid: string; action: string }[] = [];
  statuses = new Map<string, MeetingStatusInfo>();
  recordings = new Map<string, RecordingFile[]>();
  files = new Map<string, string>();
  failHostKey = false;
  failCreate = false;
  private nextId = 1000;

  async createMeeting(opts: {
    topic: string;
    record: boolean;
    passcode: string;
  }): Promise<CreatedMeeting> {
    if (this.failCreate) throw new Error("zoom down");
    this.created.push(opts);
    const id = String(++this.nextId);
    this.statuses.set(id, { status: "waiting" });
    return { id, joinUrl: `https://zoom.us/j/${id}?pwd=${opts.passcode}` };
  }

  async meetingStatus(id: string): Promise<MeetingStatusInfo> {
    return this.statuses.get(id) ?? { status: "gone" };
  }

  async endMeeting(id: string): Promise<void> {
    this.ended.push(id);
  }

  async deleteMeeting(id: string): Promise<void> {
    this.deleted.push(id);
  }

  async listRecordings(uuid: string): Promise<RecordingFile[] | null> {
    return this.recordings.get(uuid) ?? null;
  }

  async downloadText(url: string): Promise<string> {
    const f = this.files.get(url);
    if (f === undefined) throw new Error(`no file ${url}`);
    return f;
  }

  async deleteRecordings(uuid: string, action: "delete" | "trash"): Promise<void> {
    this.deletedRecordings.push({ uuid, action });
  }

  async setHostKey(key: string): Promise<void> {
    if (this.failHostKey) throw new Error("403 scope missing");
    this.hostKeys.push(key);
  }
}

export class FakeSummarizer implements Summarizer {
  calls: { title: string; transcript: string }[] = [];
  result: string | null | Error = "• We talked.\nAction items: none";
  async summarize(input: { title: string; transcript: string }): Promise<string | null> {
    this.calls.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

export const silentLog = { info() {}, warn() {}, error() {} };

export const GROUP = "120363000000000001@g.us";
export const OTHER_GROUP = "120363000000000002@g.us";
export const ALICE: Sender = {
  jid: "11111111111111@lid",
  alt: "353870000001@s.whatsapp.net",
  name: "Alice",
};
export const BOB: Sender = {
  jid: "22222222222222@lid",
  alt: "353870000002@s.whatsapp.net",
  name: "Bob",
};
export const ADMIN: Sender = {
  jid: "33333333333333@lid",
  alt: "353870000003@s.whatsapp.net",
  name: "Ada",
};

export const SAMPLE_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
Alice: Hello everyone.

2
00:00:04.500 --> 00:00:07.000
Alice: Let's start.

3
00:00:08.000 --> 00:00:10.000
Bob: Sounds good.
`;

export class Harness {
  clock = new Date("2026-11-08T10:00:00.000Z");
  store = new Store(":memory:");
  chat = new FakeChat();
  zoom = new FakeZoom();
  summarizer: FakeSummarizer | null;
  bot: Bot;

  constructor(settings: Partial<BotSettings> = {}, opts: { summarizer?: boolean } = {}) {
    this.summarizer = opts.summarizer === false ? null : new FakeSummarizer();
    this.chat.admins.add(jidKey(ADMIN.jid));
    this.bot = new Bot({
      store: this.store,
      zoom: this.zoom,
      chat: this.chat,
      summarizer: this.summarizer,
      log: silentLog,
      settings: { allowlist: ["+353 87 000 0001"], ...settings },
      now: () => this.clock,
    });
  }

  advance(minutes: number): void {
    this.clock = new Date(this.clock.getTime() + minutes * 60_000);
  }

  iso(): string {
    return this.clock.toISOString();
  }

  async say(sender: Sender, text: string, group = GROUP): Promise<void> {
    const m: IncomingMessage = {
      groupJid: group,
      sender,
      text,
      quote: { key: { id: `IN-${Math.random()}` }, text },
    };
    await this.bot.handleMessage(m);
  }

  /** Starts a meeting as Alice and returns its Zoom id. */
  async startMeeting(text = "/zoom Weekly sync", group = GROUP, who = ALICE): Promise<string> {
    await this.say(who, text, group);
    const m = this.store.activeMeeting(group);
    if (!m) throw new Error("meeting was not created");
    return m.zoom_meeting_id;
  }

  async webhook(body: ZoomEventBody): Promise<boolean> {
    const fresh = await this.bot.receiveWebhook(body);
    await this.bot.idle();
    return fresh;
  }

  started(zoomId: string, uuid: string): Promise<boolean> {
    return this.webhook({
      event: "meeting.started",
      payload: { object: { id: zoomId, uuid, start_time: this.iso() } },
    });
  }

  ended(zoomId: string, uuid: string, startedIso: string): Promise<boolean> {
    return this.webhook({
      event: "meeting.ended",
      payload: { object: { id: zoomId, uuid, start_time: startedIso, end_time: this.iso() } },
    });
  }

  transcript(zoomId: string, uuid: string, vtt = SAMPLE_VTT): Promise<boolean> {
    const url = `https://zoom.us/rec/download/${encodeURIComponent(uuid)}.vtt`;
    this.zoom.files.set(url, vtt);
    return this.webhook({
      event: "recording.transcript_completed",
      download_token: "dl-token",
      payload: {
        object: {
          id: Number(zoomId),
          uuid,
          recording_files: [
            { file_type: "MP4", download_url: "https://zoom.us/rec/x.mp4" },
            { file_type: "TRANSCRIPT", status: "completed", download_url: url },
          ],
        },
      },
    });
  }

  meeting(zoomId: string) {
    const m = this.store.meetingByZoomId(zoomId);
    if (!m) throw new Error("no meeting");
    return m;
  }
}
