import { encodeMeetingUuid } from "./uuid.js";

export interface CreatedMeeting {
  id: string;
  joinUrl: string;
}

export interface MeetingStatusInfo {
  status: "waiting" | "started" | "finished" | "gone";
  uuid?: string;
  startTime?: string;
}

export interface RecordingFile {
  fileType: string;
  status?: string;
  downloadUrl: string;
}

/** What the bot needs from Zoom. The real client is below; tests use a fake. */
export interface ZoomApi {
  createMeeting(opts: {
    topic: string;
    record: boolean;
    passcode: string;
  }): Promise<CreatedMeeting>;
  /** Live status of a meeting ("gone" if Zoom no longer knows it) and its current instance UUID. */
  meetingStatus(meetingId: string): Promise<MeetingStatusInfo>;
  endMeeting(meetingId: string): Promise<void>;
  deleteMeeting(meetingId: string): Promise<void>;
  /** Recording files for one instance, or null if Zoom has none (404). */
  listRecordings(uuid: string): Promise<RecordingFile[] | null>;
  /** Downloads a recording file as text. `token` is a webhook download_token, if given. */
  downloadText(url: string, token?: string): Promise<string>;
  deleteRecordings(uuid: string, action: "delete" | "trash"): Promise<void>;
  setHostKey(hostKey: string): Promise<void>;
}

export class ZoomHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    what: string,
  ) {
    super(`Zoom ${what} failed: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

type Fetch = typeof fetch;

export interface ZoomClientOptions {
  accountId: string;
  clientId: string;
  clientSecret: string;
  hostUser: string;
  apiBase?: string;
  oauthUrl?: string;
  fetch?: Fetch;
  now?: () => number;
}

/** Zoom REST client using Server-to-Server OAuth (account_credentials grant). */
export class ZoomClient implements ZoomApi {
  private token: { value: string; expiresAt: number } | undefined;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly apiBase: string;
  private readonly oauthUrl: string;

  constructor(private readonly opts: ZoomClientOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.apiBase = (opts.apiBase ?? "https://api.zoom.us/v2").replace(/\/$/, "");
    this.oauthUrl = opts.oauthUrl ?? "https://zoom.us/oauth/token";
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const url = new URL(this.oauthUrl);
    url.searchParams.set("grant_type", "account_credentials");
    url.searchParams.set("account_id", this.opts.accountId);
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}` },
    });
    if (!res.ok) throw new ZoomHttpError(res.status, await res.text(), "OAuth token");
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: this.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    const res = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res;
  }

  private async ok(res: Response, what: string): Promise<Response> {
    if (!res.ok) throw new ZoomHttpError(res.status, await res.text(), what);
    return res;
  }

  private get host(): string {
    return encodeURIComponent(this.opts.hostUser);
  }

  async createMeeting(opts: {
    topic: string;
    record: boolean;
    passcode: string;
  }): Promise<CreatedMeeting> {
    const what = "create meeting";
    const res = await this.ok(
      await this.call("POST", `/users/${this.host}/meetings`, {
        topic: opts.topic,
        type: 1,
        password: opts.passcode,
        settings: {
          join_before_host: true,
          jbh_time: 0,
          waiting_room: false,
          auto_recording: opts.record ? "cloud" : "none",
          mute_upon_entry: true,
          meeting_authentication: false,
        },
      }),
      what,
    );
    const json = (await res.json()) as { id: number | string; join_url: string };
    return { id: String(json.id), joinUrl: json.join_url };
  }

  async meetingStatus(meetingId: string): Promise<MeetingStatusInfo> {
    const what = "get meeting";
    const res = await this.call("GET", `/meetings/${encodeURIComponent(meetingId)}`);
    if (res.status === 404) return { status: "gone" };
    await this.ok(res, what);
    const json = (await res.json()) as { status?: string; uuid?: string; start_time?: string };
    const status =
      json.status === "started" ? "started" : json.status === "waiting" ? "waiting" : "finished";
    return { status, uuid: json.uuid, startTime: json.start_time };
  }

  async endMeeting(meetingId: string): Promise<void> {
    const what = "end meeting";
    await this.ok(
      await this.call("PUT", `/meetings/${encodeURIComponent(meetingId)}/status`, {
        action: "end",
      }),
      what,
    );
  }

  async deleteMeeting(meetingId: string): Promise<void> {
    const what = "delete meeting";
    const res = await this.call("DELETE", `/meetings/${encodeURIComponent(meetingId)}`);
    if (res.status === 404) return;
    await this.ok(res, what);
  }

  async listRecordings(uuid: string): Promise<RecordingFile[] | null> {
    const what = "list recordings";
    const res = await this.call("GET", `/meetings/${encodeMeetingUuid(uuid)}/recordings`);
    if (res.status === 404) return null;
    await this.ok(res, what);
    const json = (await res.json()) as {
      recording_files?: { file_type: string; status?: string; download_url: string }[];
    };
    return (json.recording_files ?? []).map((f) => ({
      fileType: f.file_type,
      status: f.status,
      downloadUrl: f.download_url,
    }));
  }

  async downloadText(url: string, token?: string): Promise<string> {
    const bearer = token ?? (await this.accessToken());
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
    await this.ok(res, "download recording");
    return await res.text();
  }

  async deleteRecordings(uuid: string, action: "delete" | "trash"): Promise<void> {
    const what = "delete recordings";
    const res = await this.call(
      "DELETE",
      `/meetings/${encodeMeetingUuid(uuid)}/recordings?action=${action}`,
    );
    if (res.status === 404) return;
    await this.ok(res, what);
  }

  async setHostKey(hostKey: string): Promise<void> {
    const what = "update host key";
    await this.ok(await this.call("PATCH", `/users/${this.host}`, { host_key: hostKey }), what);
  }
}
