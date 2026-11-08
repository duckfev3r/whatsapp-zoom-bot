import crypto from "node:crypto";

/** A random 6-digit host key (Zoom accepts 6 to 10 digits). Never logged or stored. */
export function generateHostKey(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

const PASSCODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** A random meeting passcode, 6 to 10 characters (8 by default). */
export function generatePasscode(length = 8): string {
  if (length < 6 || length > 10) throw new Error("Zoom passcodes are 6 to 10 characters");
  let out = "";
  for (let i = 0; i < length; i++) out += PASSCODE_CHARS[crypto.randomInt(PASSCODE_CHARS.length)];
  return out;
}
