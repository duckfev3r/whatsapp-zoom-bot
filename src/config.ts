import os from "node:os";
import path from "node:path";
import { z } from "zod";

const bool = (def: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v === "yes");

const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const defaultDataDir = path.join(os.homedir(), ".local", "share", "whatsapp-zoom-bot");

export const configSchema = z
  .object({
    // Zoom Server-to-Server OAuth app
    ZOOM_ACCOUNT_ID: z.string().min(1),
    ZOOM_CLIENT_ID: z.string().min(1),
    ZOOM_CLIENT_SECRET: z.string().min(1),
    ZOOM_WEBHOOK_SECRET_TOKEN: z.string().min(1),
    /** The licensed Zoom user who hosts every meeting: a user id or email. */
    ZOOM_HOST_USER: z.string().min(1),
    ZOOM_API_BASE: z.string().url().default("https://api.zoom.us/v2"),
    ZOOM_OAUTH_URL: z.string().url().default("https://zoom.us/oauth/token"),

    // Host key
    HOST_KEY_ROTATION: bool(true),

    // WhatsApp
    DATA_DIR: z.string().default(defaultDataDir),
    BAILEYS_AUTH_DIR: z.string().optional(),
    /** Phone number (digits, with country code) to pair by code instead of QR. */
    WA_PAIRING_NUMBER: z.string().optional(),
    /** Only answer in these groups. Empty means every group the bot is in. */
    GROUP_JIDS: list,
    /** JIDs or phone numbers allowed to start meetings, on top of group admins. */
    ALLOWLIST: list,
    ALLOW_GROUP_ADMINS: bool(true),

    // Database
    DB_PATH: z.string().optional(),

    // Webhook server
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(3000),
    WEBHOOK_PATH: z.string().default("/zoom/webhook"),

    // Summary
    SUMMARY_ENABLED: bool(true),
    ANTHROPIC_API_KEY: z.string().optional(),
    SUMMARY_MODEL: z.string().default("claude-sonnet-5-5"),
    SUMMARY_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
    SUMMARY_FALLBACKS: bool(true),
    SUMMARY_MAX_CHARS: z.coerce.number().int().positive().default(1500),

    // Lifecycle and retention
    RECORDING_RETENTION_DAYS: z.coerce.number().min(0).default(7),
    RECORDING_DELETE_ACTION: z.enum(["delete", "trash"]).default("delete"),
    EXPIRE_AFTER_MINUTES: z.coerce.number().positive().default(120),
    MIN_INSTANCE_MINUTES: z.coerce.number().min(0).default(2),
    TRANSCRIPT_GIVE_UP_HOURS: z.coerce.number().positive().default(24),
    PIN_SECONDS: z.coerce
      .number()
      .refine((v) => v === 86400 || v === 604800 || v === 2592000, "86400, 604800 or 2592000")
      .default(86400),
    TIMEZONE: z.string().default("Europe/Dublin"),
    DEFAULT_TITLE: z.string().default("Group call"),

    LOG_LEVEL: z.string().default("info"),
  })
  .transform((c) => ({
    ...c,
    BAILEYS_AUTH_DIR: c.BAILEYS_AUTH_DIR ?? path.join(c.DATA_DIR, "baileys-auth"),
    DB_PATH: c.DB_PATH ?? path.join(c.DATA_DIR, "bot.sqlite"),
  }));

export type Config = z.output<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

/** Whether summaries can run: enabled and a key is present. */
export function summaryActive(c: Config): boolean {
  return c.SUMMARY_ENABLED && Boolean(c.ANTHROPIC_API_KEY);
}
