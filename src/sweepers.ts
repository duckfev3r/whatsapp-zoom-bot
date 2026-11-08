import type { Bot } from "./lifecycle.js";

export const MINUTE = 60_000;

export interface SweeperIntervals {
  meetingsMs: number;
  transcriptsMs: number;
  retentionMs: number;
  inboxMs: number;
}

export const defaultIntervals: SweeperIntervals = {
  meetingsMs: 15 * MINUTE,
  transcriptsMs: 30 * MINUTE,
  retentionMs: 60 * MINUTE,
  inboxMs: MINUTE,
};

/**
 * Starts the periodic jobs:
 * - every 15 min, check open meetings with Zoom (missed start/end) and expire unused links;
 * - every 30 min, poll for missing transcripts (give up after 24h);
 * - hourly, delete cloud recordings past retention;
 * - every minute, retry stored webhooks that failed.
 * Returns a function that stops them.
 */
export function startSweepers(
  bot: Bot,
  onError: (job: string, err: unknown) => void,
  intervals: SweeperIntervals = defaultIntervals,
): () => void {
  const jobs: [string, number, () => Promise<void>][] = [
    ["meetings", intervals.meetingsMs, () => bot.sweepMeetings()],
    ["transcripts", intervals.transcriptsMs, () => bot.sweepTranscripts()],
    ["retention", intervals.retentionMs, () => bot.sweepRetention()],
    ["inbox", intervals.inboxMs, () => bot.drainInbox()],
  ];
  const timers = jobs.map(([name, ms, run]) =>
    setInterval(() => {
      run().catch((err) => onError(name, err));
    }, ms),
  );
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
