import type { Sender } from "../commands.js";

/** A WhatsApp message key, stored as JSON. Opaque to the core. */
export type MsgKey = Record<string, unknown>;

/** Enough of a message to quote it in a reply. */
export interface QuoteRef {
  key: MsgKey;
  text: string;
}

export interface IncomingMessage {
  groupJid: string;
  sender: Sender;
  text: string;
  /** The command message itself, so replies can quote it. */
  quote: QuoteRef;
}

export interface OutgoingDocument {
  data: Buffer;
  fileName: string;
  mimetype: string;
  caption?: string;
}

/**
 * What the core needs from WhatsApp. The Baileys adapter implements it for real;
 * tests use an in-memory fake.
 */
export interface ChatPort {
  sendText(jid: string, text: string, opts?: { quote?: QuoteRef }): Promise<MsgKey>;
  sendDocument(jid: string, doc: OutgoingDocument, opts?: { quote?: QuoteRef }): Promise<MsgKey>;
  /** Pins a message for everyone. Throws if the bot isn't allowed (not an admin). */
  pin(groupJid: string, key: MsgKey, seconds: 86400 | 604800 | 2592000): Promise<void>;
  unpin(groupJid: string, key: MsgKey): Promise<void>;
  isGroupAdmin(groupJid: string, sender: Sender): Promise<boolean>;
}
