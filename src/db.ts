import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type MeetingStatus = "created" | "live" | "ended" | "done" | "expired";

/** Why an instance needs no more work. Null means a transcript is still expected. */
export type InstanceOutcome = "posted" | "missing" | "short" | "norecord";

export interface MeetingRow {
  id: number;
  zoom_meeting_id: string;
  group_jid: string;
  title: string | null;
  join_url: string;
  record: number;
  requested_by: string;
  requester_alt: string | null;
  requester_name: string | null;
  wa_msg_key: string;
  status: MeetingStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface InstanceRow {
  uuid: string;
  meeting_id: number;
  started_at: string | null;
  ended_at: string | null;
  transcript_at: string | null;
  attempts: number;
  outcome: InstanceOutcome | null;
  recording_deleted_at: string | null;
}

export interface InboxRow {
  id: number;
  key: string;
  event: string;
  body: string;
  received_at: string;
  attempts: number;
}

// The spec's two tables, plus a few columns and two helper tables:
// - meetings.requester_alt / requester_name / started_at: for DMs, permissions and /zoom status.
// - instances.outcome / recording_deleted_at: to finish each instance and run retention.
// - inbox: webhooks are stored before they are handled, so they are replayed in order after a crash.
// - notices: the one-time messages ("make me admin", "ask an admin to add you").
// Transcript text is never stored.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id              INTEGER PRIMARY KEY,
  zoom_meeting_id TEXT NOT NULL UNIQUE,
  group_jid       TEXT NOT NULL,
  title           TEXT,
  join_url        TEXT NOT NULL,
  record          INTEGER NOT NULL DEFAULT 1,
  requested_by    TEXT NOT NULL,
  requester_alt   TEXT,
  requester_name  TEXT,
  wa_msg_key      TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT
);
CREATE INDEX IF NOT EXISTS meetings_status ON meetings(status);

CREATE TABLE IF NOT EXISTS instances (
  uuid                 TEXT PRIMARY KEY,
  meeting_id           INTEGER NOT NULL REFERENCES meetings(id),
  started_at           TEXT,
  ended_at             TEXT,
  transcript_at        TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  outcome              TEXT,
  recording_deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS instances_meeting ON instances(meeting_id);

CREATE TABLE IF NOT EXISTS inbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,
  event        TEXT NOT NULL,
  body         TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS notices (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL
);
`;

export type NewMeeting = Omit<MeetingRow, "id" | "status" | "started_at" | "ended_at">;

export class Store {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // Meetings

  insertMeeting(m: NewMeeting): MeetingRow {
    const info = this.db
      .prepare(
        `INSERT INTO meetings (zoom_meeting_id, group_jid, title, join_url, record, requested_by,
           requester_alt, requester_name, wa_msg_key, status, created_at)
         VALUES (@zoom_meeting_id, @group_jid, @title, @join_url, @record, @requested_by,
           @requester_alt, @requester_name, @wa_msg_key, 'created', @created_at)`,
      )
      .run(m);
    return this.meeting(Number(info.lastInsertRowid)) as MeetingRow;
  }

  meeting(id: number): MeetingRow | undefined {
    return this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | undefined;
  }

  meetingByZoomId(zoomId: string): MeetingRow | undefined {
    return this.db.prepare("SELECT * FROM meetings WHERE zoom_meeting_id = ?").get(zoomId) as
      | MeetingRow
      | undefined;
  }

  /** The meeting in `created` or `live` for a group, if any. */
  activeMeeting(groupJid: string): MeetingRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM meetings WHERE group_jid = ? AND status IN ('created','live') ORDER BY id DESC LIMIT 1",
      )
      .get(groupJid) as MeetingRow | undefined;
  }

  /** Every meeting in `created` or `live`, in any group. */
  activeMeetings(): MeetingRow[] {
    return this.db
      .prepare("SELECT * FROM meetings WHERE status IN ('created','live') ORDER BY id")
      .all() as MeetingRow[];
  }

  meetingsWithStatus(status: MeetingStatus): MeetingRow[] {
    return this.db
      .prepare("SELECT * FROM meetings WHERE status = ? ORDER BY id")
      .all(status) as MeetingRow[];
  }

  setStatus(id: number, status: MeetingStatus, fields: { ended_at?: string } = {}): void {
    this.db
      .prepare("UPDATE meetings SET status = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?")
      .run(status, fields.ended_at ?? null, id);
  }

  setStartedIfUnset(id: number, at: string): void {
    this.db
      .prepare("UPDATE meetings SET started_at = COALESCE(started_at, ?) WHERE id = ?")
      .run(at, id);
  }

  // Instances

  instance(uuid: string): InstanceRow | undefined {
    return this.db.prepare("SELECT * FROM instances WHERE uuid = ?").get(uuid) as
      | InstanceRow
      | undefined;
  }

  /** Inserts the instance if new. Returns true if it was inserted. */
  addInstance(uuid: string, meetingId: number, startedAt: string | null): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO instances (uuid, meeting_id, started_at) VALUES (?, ?, ?)")
      .run(uuid, meetingId, startedAt);
    return info.changes > 0;
  }

  instances(meetingId: number): InstanceRow[] {
    return this.db
      .prepare(
        "SELECT * FROM instances WHERE meeting_id = ? ORDER BY COALESCE(started_at, ended_at), rowid",
      )
      .all(meetingId) as InstanceRow[];
  }

  openInstances(meetingId: number): InstanceRow[] {
    return this.db
      .prepare("SELECT * FROM instances WHERE meeting_id = ? AND ended_at IS NULL")
      .all(meetingId) as InstanceRow[];
  }

  setInstanceEnded(uuid: string, endedAt: string): void {
    this.db
      .prepare("UPDATE instances SET ended_at = ? WHERE uuid = ? AND ended_at IS NULL")
      .run(endedAt, uuid);
  }

  setOutcome(uuid: string, outcome: InstanceOutcome, transcriptAt?: string): void {
    this.db
      .prepare(
        "UPDATE instances SET outcome = ?, transcript_at = COALESCE(?, transcript_at) WHERE uuid = ?",
      )
      .run(outcome, transcriptAt ?? null, uuid);
  }

  bumpAttempts(uuid: string): void {
    this.db.prepare("UPDATE instances SET attempts = attempts + 1 WHERE uuid = ?").run(uuid);
  }

  /** Ended instances still waiting for a transcript, on recorded meetings. */
  pendingTranscripts(): InstanceRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM instances i JOIN meetings m ON m.id = i.meeting_id
         WHERE i.ended_at IS NOT NULL AND i.outcome IS NULL AND m.record = 1
         ORDER BY i.ended_at`,
      )
      .all() as InstanceRow[];
  }

  /** Instances whose cloud recording is due for deletion. */
  recordingsDue(cutoffIso: string): InstanceRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM instances i JOIN meetings m ON m.id = i.meeting_id
         WHERE m.record = 1 AND i.recording_deleted_at IS NULL AND i.outcome IS NOT NULL
           AND i.outcome != 'norecord'
           AND COALESCE(i.transcript_at, i.ended_at) <= ?`,
      )
      .all(cutoffIso) as InstanceRow[];
  }

  setRecordingDeleted(uuid: string, at: string): void {
    this.db.prepare("UPDATE instances SET recording_deleted_at = ? WHERE uuid = ?").run(at, uuid);
  }

  // Inbox (webhook queue)

  /** Stores a webhook. Returns false if the same key was seen before. */
  enqueue(key: string, event: string, body: string, at: string): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO inbox (key, event, body, received_at) VALUES (?, ?, ?, ?)")
      .run(key, event, body, at);
    return info.changes > 0;
  }

  nextInbox(): InboxRow | undefined {
    return this.db
      .prepare("SELECT * FROM inbox WHERE processed_at IS NULL ORDER BY id LIMIT 1")
      .get() as InboxRow | undefined;
  }

  markInbox(id: number, at: string, error?: string): void {
    this.db
      .prepare("UPDATE inbox SET processed_at = ?, error = ? WHERE id = ?")
      .run(at, error ?? null, id);
  }

  failInbox(id: number, error: string): number {
    this.db
      .prepare("UPDATE inbox SET attempts = attempts + 1, error = ? WHERE id = ?")
      .run(error, id);
    const row = this.db.prepare("SELECT attempts FROM inbox WHERE id = ?").get(id) as {
      attempts: number;
    };
    return row.attempts;
  }

  pruneInbox(beforeIso: string): void {
    this.db
      .prepare("DELETE FROM inbox WHERE processed_at IS NOT NULL AND processed_at < ?")
      .run(beforeIso);
  }

  // One-time notices

  /** Records a notice. Returns true the first time only. */
  claimNotice(key: string, at: string): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO notices (key, sent_at) VALUES (?, ?)")
      .run(key, at);
    return info.changes > 0;
  }

  clearNotice(key: string): void {
    this.db.prepare("DELETE FROM notices WHERE key = ?").run(key);
  }
}
