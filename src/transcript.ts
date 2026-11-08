export interface Cue {
  start: string;
  speaker: string | null;
  text: string;
}

const TIMING = /^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function startStamp(timing: string): string {
  const first = timing.split("-->")[0]?.trim() ?? "";
  const [clock] = first.split(/[.,]/);
  const parts = (clock ?? "").split(":");
  if (parts.length === 2) parts.unshift("00");
  return parts.map((p) => p.padStart(2, "0")).join(":");
}

/** Parses a WebVTT file (as Zoom writes it) into cues. */
export function parseVtt(vtt: string): Cue[] {
  const blocks = vtt
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timingIdx = lines.findIndex((l) => TIMING.test(l.trim()));
    if (timingIdx === -1) continue; // header, NOTE, STYLE or REGION block
    const timingLine = lines[timingIdx] as string;
    const raw = lines.slice(timingIdx + 1).join(" ");
    let speaker: string | null = null;
    let text = raw;
    const voice = /^<v(?:\.[^\s>]+)?\s+([^>]+)>/.exec(text);
    if (voice?.[1]) {
      speaker = voice[1].trim();
      text = text.slice(voice[0].length);
    }
    text = decodeEntities(text.replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!speaker) {
      // Zoom writes "Name: words".
      const m = /^([^:]{1,80}):\s+(.*)$/.exec(text);
      if (m?.[1] && m[2] !== undefined && !/^\d+$/.test(m[1])) {
        speaker = m[1].trim();
        text = m[2];
      }
    }
    if (text) cues.push({ start: startStamp(timingLine.trim()), speaker, text });
  }
  return cues;
}

/**
 * Turns a VTT transcript into plain text. Consecutive cues from the same speaker are
 * joined into one paragraph that starts with the time of its first cue.
 */
export function vttToText(vtt: string): string {
  const paragraphs: { start: string; speaker: string | null; parts: string[] }[] = [];
  for (const cue of parseVtt(vtt)) {
    const last = paragraphs.at(-1);
    if (last && last.speaker === cue.speaker) last.parts.push(cue.text);
    else paragraphs.push({ start: cue.start, speaker: cue.speaker, parts: [cue.text] });
  }
  return paragraphs
    .map((p) => `[${p.start}] ${p.speaker ? `${p.speaker}: ` : ""}${p.parts.join(" ")}`)
    .join("\n\n");
}
