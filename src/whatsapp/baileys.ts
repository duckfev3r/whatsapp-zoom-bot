import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type GroupMetadata,
  isJidGroup,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from "baileys";
import type { Logger } from "pino";
import qrcode from "qrcode-terminal";
import { jidKey, type Sender, sameSender } from "../commands.js";
import type { ChatPort, IncomingMessage, MsgKey, OutgoingDocument, QuoteRef } from "./types.js";

export interface BaileysOptions {
  authDir: string;
  /** Pair by code instead of QR: the bot's phone number, digits with country code. */
  pairingNumber?: string;
  log: Logger;
  onMessage: (m: IncomingMessage) => void;
}

const PIN_FOR_ALL = 1;
const UNPIN_FOR_ALL = 2;
const ADMIN_CACHE_MS = 5 * 60 * 1000;

function textOf(m: WAMessage): string | null {
  const c = m.message;
  return c?.conversation ?? c?.extendedTextMessage?.text ?? null;
}

function toQuoted(q: QuoteRef): WAMessage {
  return { key: q.key as WAMessageKey, message: { conversation: q.text } } as WAMessage;
}

/**
 * The Baileys (unofficial WhatsApp Web) adapter. It keeps one socket open, reconnects
 * when it drops, and waits for the connection before sending.
 */
export class BaileysChat implements ChatPort {
  private sock: WASocket | undefined;
  private ready: Promise<void>;
  private markReady: () => void = () => undefined;
  private stopped = false;
  private readonly admins = new Map<string, { at: number; meta: GroupMetadata }>();

  constructor(private readonly opts: BaileysOptions) {
    this.ready = this.newReadyPromise();
  }

  private newReadyPromise(): Promise<void> {
    return new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.opts.log.child({ module: "baileys" }, { level: "warn" }),
      browser: Browsers.ubuntu("Zoom Bot"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    if (this.opts.pairingNumber && !state.creds.registered) {
      const number = this.opts.pairingNumber.replace(/\D/g, "");
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(number);
          this.opts.log.info(
            `Pairing code: ${code}. On the bot's phone: WhatsApp > Linked devices > Link with phone number.`,
          );
        } catch (err) {
          this.opts.log.error({ err }, "pairing code request failed");
        }
      }, 3000);
    }

    sock.ev.on("connection.update", (u) => {
      if (u.qr && !this.opts.pairingNumber) {
        this.opts.log.info("Scan this QR code with WhatsApp > Linked devices on the bot's phone:");
        qrcode.generate(u.qr, { small: true });
      }
      if (u.connection === "open") {
        this.opts.log.info("WhatsApp connected");
        this.markReady();
      }
      if (u.connection === "close") {
        this.ready = this.newReadyPromise();
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.opts.log.error(
            "WhatsApp logged out. Delete the auth folder and pair again (see README).",
          );
          return;
        }
        if (this.stopped) return;
        this.opts.log.warn({ code }, "WhatsApp connection closed; reconnecting");
        setTimeout(() => void this.start(), 2000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const group = m.key.remoteJid;
        if (!group || !isJidGroup(group) || m.key.fromMe) continue;
        const text = textOf(m);
        if (!text?.trimStart().toLowerCase().startsWith("/zoom")) continue;
        const participant = m.key.participant;
        if (!participant) continue;
        const sender: Sender = {
          jid: participant,
          alt: m.key.participantAlt ?? undefined,
          name: m.pushName ?? undefined,
        };
        this.opts.log.info({ group }, "command received");
        this.opts.onMessage({
          groupJid: group,
          sender,
          text,
          quote: { key: m.key as MsgKey, text },
        });
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.sock?.end(undefined);
  }

  private async socket(): Promise<WASocket> {
    await this.ready;
    if (!this.sock) throw new Error("WhatsApp socket not started");
    return this.sock;
  }

  async sendText(jid: string, text: string, opts?: { quote?: QuoteRef }): Promise<MsgKey> {
    const sock = await this.socket();
    const sent = await sock.sendMessage(
      jid,
      { text },
      opts?.quote ? { quoted: toQuoted(opts.quote) } : {},
    );
    if (!sent) throw new Error("sendMessage returned nothing");
    return sent.key as MsgKey;
  }

  async sendDocument(
    jid: string,
    doc: OutgoingDocument,
    opts?: { quote?: QuoteRef },
  ): Promise<MsgKey> {
    const sock = await this.socket();
    const sent = await sock.sendMessage(
      jid,
      { document: doc.data, fileName: doc.fileName, mimetype: doc.mimetype, caption: doc.caption },
      opts?.quote ? { quoted: toQuoted(opts.quote) } : {},
    );
    if (!sent) throw new Error("sendMessage returned nothing");
    return sent.key as MsgKey;
  }

  async pin(groupJid: string, key: MsgKey, seconds: 86400 | 604800 | 2592000): Promise<void> {
    const sock = await this.socket();
    const meta = await this.metadata(groupJid, true);
    const me = sock.user;
    const bot: Sender = { jid: me?.lid ?? me?.id ?? "", alt: me?.id };
    // WhatsApp silently ignores pins from non-admins, so check first.
    if (!meta.participants.some((p) => p.admin && matches(p, bot))) {
      throw new Error("the bot is not a group admin");
    }
    await sock.sendMessage(groupJid, {
      pin: key as WAMessageKey,
      type: PIN_FOR_ALL,
      time: seconds,
    });
  }

  async unpin(groupJid: string, key: MsgKey): Promise<void> {
    const sock = await this.socket();
    await sock.sendMessage(groupJid, { pin: key as WAMessageKey, type: UNPIN_FOR_ALL });
  }

  async isGroupAdmin(groupJid: string, sender: Sender): Promise<boolean> {
    const meta = await this.metadata(groupJid, false);
    return meta.participants.some((p) => Boolean(p.admin) && matches(p, sender));
  }

  private async metadata(groupJid: string, fresh: boolean): Promise<GroupMetadata> {
    const cached = this.admins.get(groupJid);
    if (!fresh && cached && Date.now() - cached.at < ADMIN_CACHE_MS) return cached.meta;
    const sock = await this.socket();
    const meta = await sock.groupMetadata(groupJid);
    this.admins.set(groupJid, { at: Date.now(), meta });
    return meta;
  }
}

function matches(p: { id: string; lid?: string; phoneNumber?: string }, s: Sender): boolean {
  const ids = [p.id, p.lid, p.phoneNumber].filter((x): x is string => Boolean(x));
  return ids.some((id) => sameSender(s, { jid: jidKey(id) }));
}
