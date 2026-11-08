import { describe, expect, it } from "vitest";
import { loadConfig, summaryActive } from "../src/config.js";

const base = {
  ZOOM_ACCOUNT_ID: "a",
  ZOOM_CLIENT_ID: "b",
  ZOOM_CLIENT_SECRET: "c",
  ZOOM_WEBHOOK_SECRET_TOKEN: "d",
  ZOOM_HOST_USER: "host@example.com",
};

describe("config", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig({ ...base, DATA_DIR: "/var/lib/zoombot" });
    expect(c.HOST_KEY_ROTATION).toBe(true);
    expect(c.SUMMARY_MODEL).toBe("claude-sonnet-5-5");
    expect(c.RECORDING_RETENTION_DAYS).toBe(7);
    expect(c.ALLOW_GROUP_ADMINS).toBe(true);
    expect(c.ALLOWLIST).toEqual([]);
    expect(c.DB_PATH).toBe("/var/lib/zoombot/bot.sqlite");
    expect(c.BAILEYS_AUTH_DIR).toBe("/var/lib/zoombot/baileys-auth");
  });

  it("parses lists and booleans", () => {
    const c = loadConfig({
      ...base,
      ALLOWLIST: "353870000001, 111@lid ,",
      SUMMARY_ENABLED: "false",
      HOST_KEY_ROTATION: "0",
    });
    expect(c.ALLOWLIST).toEqual(["353870000001", "111@lid"]);
    expect(c.SUMMARY_ENABLED).toBe(false);
    expect(c.HOST_KEY_ROTATION).toBe(false);
  });

  it("turns summaries off without an API key", () => {
    expect(summaryActive(loadConfig(base))).toBe(false);
    expect(summaryActive(loadConfig({ ...base, ANTHROPIC_API_KEY: "k" }))).toBe(true);
    expect(
      summaryActive(loadConfig({ ...base, ANTHROPIC_API_KEY: "k", SUMMARY_ENABLED: "false" })),
    ).toBe(false);
  });

  it("names missing settings", () => {
    expect(() => loadConfig({})).toThrow(/ZOOM_ACCOUNT_ID/);
  });

  it("rejects pin times WhatsApp doesn't support", () => {
    expect(() => loadConfig({ ...base, PIN_SECONDS: "3600" })).toThrow(/PIN_SECONDS/);
  });
});
