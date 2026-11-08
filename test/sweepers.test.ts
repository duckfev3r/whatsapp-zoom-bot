import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "../src/lifecycle.js";
import { defaultIntervals, MINUTE, startSweepers } from "../src/sweepers.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startSweepers", () => {
  it("runs each job on the spec's schedule and stops cleanly", async () => {
    vi.useFakeTimers();
    const counts = { meetings: 0, transcripts: 0, retention: 0, inbox: 0 };
    const bot = {
      sweepMeetings: async () => void counts.meetings++,
      sweepTranscripts: async () => void counts.transcripts++,
      sweepRetention: async () => void counts.retention++,
      drainInbox: async () => void counts.inbox++,
    } as unknown as Bot;
    const stop = startSweepers(bot, () => undefined);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(counts).toEqual({ meetings: 4, transcripts: 2, retention: 1, inbox: 60 });
    stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(counts.meetings).toBe(4);
    expect(defaultIntervals.meetingsMs).toBe(15 * MINUTE);
    expect(defaultIntervals.transcriptsMs).toBe(30 * MINUTE);
  });

  it("reports job errors without stopping", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const bot = {
      sweepMeetings: async () => {
        throw new Error("boom");
      },
      sweepTranscripts: async () => undefined,
      sweepRetention: async () => undefined,
      drainInbox: async () => undefined,
    } as unknown as Bot;
    const stop = startSweepers(bot, (job) => errors.push(job));
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    stop();
    expect(errors).toEqual(["meetings", "meetings"]);
  });
});
