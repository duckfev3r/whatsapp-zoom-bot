import { describe, expect, it } from "vitest";
import { allowlistMatches, jidKey, jidUser, parseCommand, sameSender } from "../src/commands.js";

describe("parseCommand", () => {
  it("ignores other messages", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("/zoomer")).toBeNull();
    expect(parseCommand("let's /zoom")).toBeNull();
  });

  it("parses /zoom with and without a title", () => {
    expect(parseCommand("/zoom")).toEqual({ kind: "start", record: true, title: null });
    expect(parseCommand("  /zoom   Weekly   sync ")).toEqual({
      kind: "start",
      record: true,
      title: "Weekly sync",
    });
    expect(parseCommand("/ZOOM Planning")).toEqual({
      kind: "start",
      record: true,
      title: "Planning",
    });
  });

  it("parses norecord", () => {
    expect(parseCommand("/zoom norecord")).toEqual({ kind: "start", record: false, title: null });
    expect(parseCommand("/zoom NoRecord Private chat")).toEqual({
      kind: "start",
      record: false,
      title: "Private chat",
    });
  });

  it("parses end, status and help", () => {
    expect(parseCommand("/zoom end")).toEqual({ kind: "end" });
    expect(parseCommand("/zoom Status")).toEqual({ kind: "status" });
    expect(parseCommand("/zoom help")).toEqual({ kind: "help" });
  });

  it("treats extra words after a keyword as a title", () => {
    expect(parseCommand("/zoom end of year party")).toEqual({
      kind: "start",
      record: true,
      title: "end of year party",
    });
  });

  it("caps titles at 200 characters", () => {
    const cmd = parseCommand(`/zoom ${"x".repeat(300)}`);
    expect(cmd?.kind === "start" && cmd.title?.length).toBe(200);
  });

  it("keeps multi-line titles on one line", () => {
    expect(parseCommand("/zoom a\nb")).toEqual({ kind: "start", record: true, title: "a b" });
  });
});

describe("JID helpers", () => {
  it("strips device suffixes", () => {
    expect(jidUser("353870000001:12@s.whatsapp.net")).toBe("353870000001");
    expect(jidKey("353870000001:12@s.whatsapp.net")).toBe("353870000001@s.whatsapp.net");
  });

  it("compares senders across LID and phone JIDs", () => {
    const a = { jid: "111@lid", alt: "353870000001@s.whatsapp.net" };
    expect(sameSender(a, { jid: "353870000001:3@s.whatsapp.net" })).toBe(true);
    expect(sameSender(a, { jid: "111@lid", alt: null })).toBe(true);
    expect(sameSender(a, { jid: "222@lid" })).toBe(false);
  });
});

describe("allowlistMatches", () => {
  const sender = { jid: "111@lid", alt: "353870000001@s.whatsapp.net" };
  it("matches phone numbers in any format", () => {
    expect(allowlistMatches(["+353 87 000 0001"], sender)).toBe(true);
    expect(allowlistMatches(["353870000001"], sender)).toBe(true);
    expect(allowlistMatches(["353870000009"], sender)).toBe(false);
  });
  it("matches full JIDs", () => {
    expect(allowlistMatches(["111@lid"], sender)).toBe(true);
    expect(allowlistMatches(["353870000001@s.whatsapp.net"], sender)).toBe(true);
  });
  it("matches nothing when empty", () => {
    expect(allowlistMatches([], sender)).toBe(false);
    expect(allowlistMatches(["   "], sender)).toBe(false);
  });
});
