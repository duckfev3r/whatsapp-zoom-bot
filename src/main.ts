import pino from "pino";
import { loadConfig, summaryActive } from "./config.js";
import { Store } from "./db.js";
import { Bot, type ZoomEventBody } from "./lifecycle.js";
import { buildServer } from "./server.js";
import { ClaudeSummarizer } from "./summary.js";
import { startSweepers } from "./sweepers.js";
import { BaileysChat } from "./whatsapp/baileys.js";
import { ZoomClient } from "./zoom/client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });
  const store = new Store(config.DB_PATH);

  const zoom = new ZoomClient({
    accountId: config.ZOOM_ACCOUNT_ID,
    clientId: config.ZOOM_CLIENT_ID,
    clientSecret: config.ZOOM_CLIENT_SECRET,
    hostUser: config.ZOOM_HOST_USER,
    apiBase: config.ZOOM_API_BASE,
    oauthUrl: config.ZOOM_OAUTH_URL,
  });

  const summarizer = summaryActive(config)
    ? new ClaudeSummarizer({
        apiKey: config.ANTHROPIC_API_KEY as string,
        model: config.SUMMARY_MODEL,
        effort: config.SUMMARY_EFFORT,
        maxChars: config.SUMMARY_MAX_CHARS,
        fallbacks: config.SUMMARY_FALLBACKS,
      })
    : null;
  if (!summarizer) log.info("AI summaries are off; transcripts are posted without one");

  let bot: Bot | undefined;
  const chat = new BaileysChat({
    authDir: config.BAILEYS_AUTH_DIR,
    pairingNumber: config.WA_PAIRING_NUMBER,
    log,
    onMessage: (m) => {
      bot?.handleMessage(m).catch((err) => log.error({ err }, "command failed"));
    },
  });

  bot = new Bot({
    store,
    zoom,
    chat,
    summarizer,
    log,
    settings: {
      groupJids: config.GROUP_JIDS,
      allowlist: config.ALLOWLIST,
      allowGroupAdmins: config.ALLOW_GROUP_ADMINS,
      hostKeyRotation: config.HOST_KEY_ROTATION,
      defaultTitle: config.DEFAULT_TITLE,
      pinSeconds: config.PIN_SECONDS as 86400 | 604800 | 2592000,
      expireAfterMinutes: config.EXPIRE_AFTER_MINUTES,
      minInstanceMinutes: config.MIN_INSTANCE_MINUTES,
      transcriptGiveUpHours: config.TRANSCRIPT_GIVE_UP_HOURS,
      retentionDays: config.RECORDING_RETENTION_DAYS,
      deleteAction: config.RECORDING_DELETE_ACTION,
      timezone: config.TIMEZONE,
    },
  });
  const core = bot;

  const server = buildServer({
    secret: config.ZOOM_WEBHOOK_SECRET_TOKEN,
    path: config.WEBHOOK_PATH,
    onEvent: (body) => core.receiveWebhook(body as ZoomEventBody),
    logger: { level: config.LOG_LEVEL },
  });

  await chat.start();
  await server.listen({ host: config.HOST, port: config.PORT });

  // Replay any webhooks stored before a restart, then start the sweepers.
  void core.drainInbox();
  void core.sweepMeetings();
  const stopSweepers = startSweepers(core, (job, err) => log.error({ err, job }, "sweeper failed"));

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    stopSweepers();
    await server.close();
    await core.idle();
    chat.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
