// Every message the bot posts, in one place.

export const HELP = [
  "*Zoom bot commands*",
  "/zoom [title] — start a recorded meeting and post the link",
  "/zoom norecord [title] — start a meeting without recording",
  "/zoom end — end the live meeting (whoever started it, or an admin)",
  "/zoom status — say whether a meeting is live",
  "/zoom help — show this list",
].join("\n");

export function created(opts: {
  title: string;
  joinUrl: string;
  name: string;
  record: boolean;
}): string {
  const tail = opts.record
    ? "This meeting is recorded, and the transcript will be shared here."
    : "This meeting is not recorded.";
  return `📹 _${opts.title}_ — ${opts.joinUrl}. Started by ${opts.name}. ${tail}`;
}

export function hostKeyDm(title: string, hostKey: string): string {
  return [
    `Host key for "${title}": ${hostKey}`,
    "If the meeting needs moderating, open Participants in Zoom and choose Claim host, then enter this key.",
    "It works for this meeting only. Please don't share it.",
  ].join("\n");
}

export function hostKeyUnavailable(title: string): string {
  return `Host claim isn't available for "${title}". The bot couldn't set a fresh host key, so there's no key to give you.`;
}

export const ALREADY_ACTIVE = "A meeting is already open in this group:";
export const HOST_BUSY =
  "The bot's Zoom host is already running a meeting for another group. Try again when it ends.";
export const NOT_ALLOWED = "Ask an admin to add you.";
export const NO_MEETING = "No meeting is live.";
export const ENDING = "Ending the meeting.";
export const CANCELLED = "Meeting cancelled before anyone joined.";
export const CREATE_FAILED = "Sorry, I couldn't create the Zoom meeting. Please try again later.";
export const END_FAILED = "Sorry, I couldn't end the meeting through Zoom.";
export const MAKE_ME_ADMIN =
  "I couldn't pin the meeting link. Make me a group admin so I can pin live meetings.";
export const EXPIRED = "Link expired: nobody joined within 2 hours.";

export function onlyRequesterCanEnd(name: string): string {
  return `Only ${name} or a group admin can end this meeting.`;
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function ended(opts: { durationMs: number; note: "transcript" | "short" | "none" }): string {
  const d = formatDuration(opts.durationMs);
  if (opts.note === "transcript") return `Meeting ended (${d}). Transcript to follow.`;
  if (opts.note === "short") return `Meeting ended (${d}). It was too short to transcribe.`;
  return `Meeting ended (${d}).`;
}

export function partLabel(title: string, part: number | null): string {
  return part ? `${title} — Part ${part}` : title;
}

export function transcriptCaption(opts: {
  title: string;
  part: number | null;
  summary: string | null;
  summaryFailed: boolean;
}): string {
  const label = partLabel(opts.title, opts.part);
  if (opts.summary)
    return `📝 *AI summary* — ${label}\n\n${opts.summary}\n\nFull transcript attached.`;
  if (opts.summaryFailed)
    return `📝 Transcript — ${label}\n\n(The AI summary couldn't be written.)`;
  return `📝 Transcript — ${label}`;
}

export function noTranscript(title: string, part: number | null): string {
  return `No transcript available for ${partLabel(title, part)}.`;
}

export function status(opts: {
  live: boolean;
  title: string;
  name: string;
  at: string;
  joinUrl: string;
}): string {
  return opts.live
    ? `A meeting is live: _${opts.title}_, started by ${opts.name} at ${opts.at}. ${opts.joinUrl}`
    : `A meeting link is open but nobody has joined yet: _${opts.title}_, started by ${opts.name} at ${opts.at}. ${opts.joinUrl}`;
}
