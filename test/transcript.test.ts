import { describe, expect, it } from "vitest";
import { parseVtt, vttToText } from "../src/transcript.js";
import { SAMPLE_VTT } from "./fakes.js";

describe("VTT parsing", () => {
  it("reads Zoom's numbered cues with speaker prefixes", () => {
    expect(parseVtt(SAMPLE_VTT)).toEqual([
      { start: "00:00:01", speaker: "Alice", text: "Hello everyone." },
      { start: "00:00:04", speaker: "Alice", text: "Let's start." },
      { start: "00:00:08", speaker: "Bob", text: "Sounds good." },
    ]);
  });

  it("joins consecutive cues from the same speaker", () => {
    expect(vttToText(SAMPLE_VTT)).toBe(
      "[00:00:01] Alice: Hello everyone. Let's start.\n\n[00:00:08] Bob: Sounds good.",
    );
  });

  it("handles CRLF, BOM, NOTE blocks, voice tags, entities and hour-less times", () => {
    const vtt = [
      "﻿WEBVTT",
      "",
      "NOTE this is a comment",
      "",
      "00:05.000 --> 00:07.000 align:start",
      "<v Carol Ann>Fish &amp; chips</v>",
      "",
      "01:02:03.000 --> 01:02:04.000",
      "<i>no speaker</i> here",
      "",
    ].join("\r\n");
    expect(vttToText(vtt)).toBe("[00:00:05] Carol Ann: Fish & chips\n\n[01:02:03] no speaker here");
  });

  it("returns empty text for an empty transcript", () => {
    expect(vttToText("WEBVTT\n\n")).toBe("");
  });

  it("keeps multi-line cue text together", () => {
    const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nDan: first line\nsecond line\n";
    expect(vttToText(vtt)).toBe("[00:00:01] Dan: first line second line");
  });
});
