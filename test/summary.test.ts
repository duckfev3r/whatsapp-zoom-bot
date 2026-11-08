import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeSummarizer, clampSummary, summaryPrompt } from "../src/summary.js";

function fakeClient(response: object) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return response;
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const opts = { apiKey: "k", model: "claude-sonnet-5-5", effort: "medium" as const, maxChars: 1500 };

describe("ClaudeSummarizer", () => {
  it("sends the transcript with the configured model and the refusal fallback", async () => {
    const { client, calls } = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "• Point\nAction items: none" }],
    });
    const s = new ClaudeSummarizer({ ...opts, fallbacks: true, client });
    expect(await s.summarize({ title: "Sync", transcript: "[00:00:01] A: hi" })).toBe(
      "• Point\nAction items: none",
    );
    const p = calls[0] as Record<string, unknown>;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(JSON.stringify(p.messages)).toContain("[00:00:01] A: hi");
  });

  it("can turn the fallback off", async () => {
    const { client, calls } = fakeClient({ stop_reason: "end_turn", content: [] });
    await new ClaudeSummarizer({ ...opts, fallbacks: false, client }).summarize({
      title: "t",
      transcript: "x",
    });
    expect(calls[0]).not.toHaveProperty("fallbacks");
    expect(calls[0]).not.toHaveProperty("betas");
  });

  it("returns null on a refusal", async () => {
    const { client } = fakeClient({ stop_reason: "refusal", content: [] });
    const s = new ClaudeSummarizer({ ...opts, fallbacks: true, client });
    expect(await s.summarize({ title: "t", transcript: "x" })).toBeNull();
  });

  it("keeps the summary under the limit", async () => {
    const long = Array.from({ length: 100 }, (_, i) => `• point ${i} ${"x".repeat(30)}`).join("\n");
    const { client } = fakeClient({
      stop_reason: "end_turn",
      content: [{ type: "text", text: long }],
    });
    const out = await new ClaudeSummarizer({ ...opts, fallbacks: true, client }).summarize({
      title: "t",
      transcript: "x",
    });
    expect(out?.length).toBeLessThanOrEqual(1500);
  });
});

describe("summary helpers", () => {
  it("asks for 5-10 bullets plus action items", () => {
    const p = summaryPrompt(1500);
    expect(p).toMatch(/5 to 10 bullet/);
    expect(p).toMatch(/Action items/);
    expect(p).toMatch(/1500/);
  });

  it("clamps at a line break", () => {
    expect(clampSummary("short", 10)).toBe("short");
    const out = clampSummary("line one here\nline two here\nline three", 30);
    expect(out).toBe("line one here\nline two here…");
  });
});
