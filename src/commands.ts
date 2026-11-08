export type Command =
  | { kind: "start"; record: boolean; title: string | null }
  | { kind: "end" }
  | { kind: "status" }
  | { kind: "help" };

const MAX_TITLE = 200; // Zoom's topic limit

/** Parses a group message. Returns null if it isn't a /zoom command. */
export function parseCommand(text: string): Command | null {
  const m = /^\s*\/zoom(?:@\S+)?(?=\s|$)(.*)$/is.exec(text);
  if (!m) return null;
  const rest = (m[1] ?? "").trim();
  const [first = "", ...others] = rest.split(/\s+/);
  const word = first.toLowerCase();
  const tail = rest.slice(first.length).trim();
  if (word === "end" && others.length === 0) return { kind: "end" };
  if (word === "status" && others.length === 0) return { kind: "status" };
  if (word === "help" && others.length === 0) return { kind: "help" };
  if (word === "norecord") return { kind: "start", record: false, title: cleanTitle(tail) };
  return { kind: "start", record: true, title: cleanTitle(rest) };
}

function cleanTitle(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  return t || null;
}

/** Digits of the user part of a JID ("353871234567:12@s.whatsapp.net" -> "353871234567"). */
export function jidUser(jid: string): string {
  return jid.split("@")[0]?.split(":")[0] ?? "";
}

export interface Sender {
  /** The JID WhatsApp used for the sender (may be a LID). */
  jid: string;
  /** The other form of the sender's JID (phone number JID), if known. */
  alt?: string;
  name?: string;
}

/** Whether an allowlist entry (a JID or a phone number) matches the sender. */
export function allowlistMatches(entries: readonly string[], sender: Sender): boolean {
  const ids = [sender.jid, sender.alt].filter((x): x is string => Boolean(x));
  return entries.some((raw) => {
    const entry = raw.trim();
    if (entry.includes("@")) {
      return ids.some((id) => id === entry || jidKey(id) === jidKey(entry));
    }
    const digits = entry.replace(/\D/g, "");
    return digits !== "" && ids.some((id) => jidUser(id) === digits);
  });
}

/** "user@server" with any device suffix removed. */
export function jidKey(jid: string): string {
  const [user = "", server = ""] = jid.split("@");
  return `${user.split(":")[0]}@${server}`;
}

/** Whether two senders are the same person, comparing every JID form we know. */
export function sameSender(a: Sender, b: { jid: string; alt?: string | null }): boolean {
  const left = [a.jid, a.alt].filter((x): x is string => Boolean(x)).map(jidKey);
  const right = [b.jid, b.alt].filter((x): x is string => Boolean(x)).map(jidKey);
  return left.some((x) => right.includes(x));
}
