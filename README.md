# WhatsApp Zoom Bot

A bot for a WhatsApp group. Someone types `/zoom` and the bot creates a Zoom meeting and posts the link. It pins the link while the meeting is live and unpins it when the meeting ends. When Zoom has processed the recording, the bot posts an AI summary with the full transcript attached as a `.txt` file.

The full spec is in [docs/SPEC.md](docs/SPEC.md).

## Contents

- [What it does](#what-it-does)
- [Risks: read this first](#risks-read-this-first)
- [Step 1: the 10-minute Zoom smoke test](#step-1-the-10-minute-zoom-smoke-test)
- [Setup](#setup)
- [Commands](#commands)
- [How it works](#how-it-works)
- [Decisions on the spec's open items](#decisions-on-the-specs-open-items)
- [Where this differs from the spec](#where-this-differs-from-the-spec)
- [Development](#development)

## What it does

- `/zoom [title]` creates a Zoom meeting and posts the link in the group. The link includes the passcode.
- The person who asked gets a private message with a fresh host key. They can use it to claim host and moderate.
- When the first person joins, the bot pins the link for 24 hours.
- When the meeting ends, the bot unpins the link and posts "Meeting ended (42 min). Transcript to follow."
- When Zoom's transcript is ready, the bot posts an "AI summary" (5 to 10 bullets plus action items). The full transcript is attached as a `.txt` file.
- If people leave and rejoin, each part gets its own transcript, labelled "Part 1", "Part 2" and so on. Parts under 2 minutes are dropped.
- Zoom cloud recordings are deleted 7 days after the transcript is posted.

It runs as one always-on Node process on a small server, behind Caddy for HTTPS.

## Risks: read this first

**WhatsApp may ban the bot's number.** The bot uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. This breaks WhatsApp's terms of service. Use a dedicated prepaid SIM, never your own number. The bot only sends messages when someone types a command or Zoom sends an event, which keeps volume low. If the number is banned, get a new SIM and pair again. The group itself is not affected.

**Recording needs consent (GDPR).** Everyone in a recorded meeting must know it is being recorded.

- The link message says the meeting is recorded and the transcript will be shared in the group.
- Turn on Zoom's recording disclaimer, so people see a notice when they join.
- Use `/zoom norecord` for meetings that shouldn't be recorded.
- Put a short note about the bot in the group description.

**Transcripts go to Anthropic.** With summaries on, each transcript is sent to the Anthropic Claude API to write the summary. Tell the group. Set `SUMMARY_ENABLED=false` to turn this off; the transcript is then posted without a summary.

**Transcripts stay in WhatsApp.** The bot doesn't keep transcript text. It deletes Zoom's cloud recordings after 7 days. But the `.txt` file posted in the group stays there until someone deletes it.

**Host keys.** A Zoom host key lets anyone claim host in every meeting run by the bot's Zoom user. So the bot sets a new random key before each meeting, sends it only to the person who asked, and never stores it. If setting the key fails, the bot doesn't send an old key. It tells the requester that host claim isn't available for that meeting.

## Step 1: the 10-minute Zoom smoke test

**Do this before going live.** The whole design assumes Zoom will record a meeting that no host ever joins. Zoom says it does, but account settings can stop it. This test checks it on your real account. It also confirms the extra API scopes.

You need the Zoom account set up as in [Zoom account settings](#1-zoom-account-settings) and the [Server-to-Server OAuth app](#2-zoom-server-to-server-oauth-app). Put the `ZOOM_*` values in `.env`. Then:

1. Create a meeting with the bot's settings:

   ```
   scripts/zoom-smoke.sh create
   ```

   Note the `id` and `join_url`. You should see `HTTP 201`.
2. Join the `join_url` from two devices. Don't sign in as the host account. Talk for 3 minutes, then both leave.
3. Wait 10 to 30 minutes. Then check for a transcript:

   ```
   scripts/zoom-smoke.sh recordings <meeting id>
   ```

   You want a file with `"file_type": "TRANSCRIPT"`. Also check the recording in the Zoom web portal, under Recordings.
4. Check that `recording.transcript_completed` fired. Open your app in the Zoom App Marketplace and look at the event logs. Or, if the bot is already deployed, run `journalctl -u whatsapp-zoom-bot | grep "webhook received"`.
5. Test the host key update:

   ```
   scripts/zoom-smoke.sh hostkey
   ```

   `HTTP 204` means the scope is right. If you get an error about scopes, add the scope it names.
6. Test recording deletion:

   ```
   scripts/zoom-smoke.sh delete-recordings <meeting id>
   ```

   `HTTP 204` means it worked. The test moves the recording to Zoom's trash.

**If no recording appears:** check the account-level settings below, especially "Automatic recording" and that recording isn't locked off by an admin. As a last resort, the spec suggests having the bot's host join through a headless Zoom client. That isn't built.

Write down the scopes you had to add. If any differ from the table below, please update this README.

## Setup

### 1. Zoom account settings

You need Zoom Pro or higher, with one licensed user who hosts every meeting. Sign in as that user (or an admin) at zoom.us and set:

- **Settings > Recording > Cloud recording:** on.
- **Cloud recording > Create audio transcript:** on.
- **Recording disclaimer:** on (shows a consent notice on join).
- **Settings > Meeting > Join before host:** allowed. Don't lock it off at account level.
- **Waiting room:** not forced on at account level. The bot turns it off per meeting.
- **Authenticated users only:** not forced on at account level.

### 2. Zoom Server-to-Server OAuth app

1. Go to the [Zoom App Marketplace](https://marketplace.zoom.us/) > Develop > Build App > **Server-to-Server OAuth**.
2. Copy the **Account ID**, **Client ID** and **Client secret** into `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`.
3. Add these scopes:

| Scope                                             | Used for                           | Status                |
| ------------------------------------------------- | ---------------------------------- | --------------------- |
| `meeting:write:meeting:admin`                     | Create meetings                    | From the spec         |
| `meeting:read:meeting:admin`                      | Sweeper checks a meeting's status  | From the spec         |
| `cloud_recording:read:list_recording_files:admin` | List an instance's recording files | From the spec         |
| `cloud_recording:read:recording:admin`            | Download the transcript            | From the spec         |
| `meeting:update:status:admin`                     | `/zoom end`                        | Confirm in smoke test |
| `meeting:delete:meeting:admin`                    | Delete links nobody used           | Confirm in smoke test |
| `cloud_recording:delete:recording_file:admin`     | Delete recordings after 7 days     | Confirm in smoke test |
| `user:update:user:admin`                          | Set a new host key per meeting     | Confirm in smoke test |

Zoom renames granular scopes from time to time. If a call fails with a scope error, Zoom's error message names the scope it wants.

4. Activate the app.

### 3. Zoom event subscriptions

In the same app, under **Feature > General features > Event subscriptions**:

1. Add a subscription. Set the endpoint URL to `https://<your host>/zoom/webhook`.
2. Copy the **Secret token** into `ZOOM_WEBHOOK_SECRET_TOKEN`.
3. Add these events:
   - Meeting > **Start Meeting** (`meeting.started`)
   - Meeting > **End Meeting** (`meeting.ended`)
   - Recording > **Recording transcript files have completed** (`recording.transcript_completed`)
4. Click **Validate**. The bot must be running and reachable for this. It answers Zoom's `endpoint.url_validation` challenge.

The bot checks the `x-zm-signature` header on every request, including the validation request. It rejects anything older than 5 minutes.

### 4. Server

You need a small Linux server with Node 22 or later, Caddy, and a domain name pointing at it.

```
sudo useradd --system --home /opt/whatsapp-zoom-bot --shell /usr/sbin/nologin zoombot
sudo git clone https://github.com/duckfev3r/whatsapp-zoom-bot /opt/whatsapp-zoom-bot
cd /opt/whatsapp-zoom-bot
sudo npm ci
sudo npm run build
sudo chown -R zoombot:zoombot /opt/whatsapp-zoom-bot

sudo mkdir -p /etc/whatsapp-zoom-bot
sudo cp .env.example /etc/whatsapp-zoom-bot/env
sudo chown zoombot:zoombot /etc/whatsapp-zoom-bot/env
sudo chmod 600 /etc/whatsapp-zoom-bot/env
sudo nano /etc/whatsapp-zoom-bot/env    # fill in the real values

sudo cp deploy/whatsapp-zoom-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Set up Caddy with [deploy/Caddyfile.example](deploy/Caddyfile.example). Change `bot.example.com` to your domain. For logs and rotation, see [deploy/LOGGING.md](deploy/LOGGING.md).

The Baileys auth folder and the SQLite database live in `/var/lib/whatsapp-zoom-bot`, readable only by the `zoombot` user. Nothing secret is kept in the repo folder.

### 5. Settings

All settings come from environment variables. [.env.example](.env.example) lists them all with dummy values.

| Variable                                                  | Default                            | What it does                                                                            |
| --------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | required                           | Server-to-Server OAuth app                                                              |
| `ZOOM_WEBHOOK_SECRET_TOKEN`                               | required                           | Checks webhook signatures                                                               |
| `ZOOM_HOST_USER`                                          | required                           | Email or user ID of the licensed host user                                              |
| `HOST_KEY_ROTATION`                                       | `true`                             | Set a new host key per meeting and DM it to the requester. `false` sends no key at all. |
| `DATA_DIR`                                                | `~/.local/share/whatsapp-zoom-bot` | Where the Baileys auth folder and SQLite file go                                        |
| `BAILEYS_AUTH_DIR`                                        | `$DATA_DIR/baileys-auth`           | WhatsApp login. Treat it like a password.                                               |
| `DB_PATH`                                                 | `$DATA_DIR/bot.sqlite`             | SQLite database                                                                         |
| `WA_PAIRING_NUMBER`                                       | empty                              | Pair by code instead of QR (bot's number, digits only)                                  |
| `GROUP_JIDS`                                              | empty                              | Only answer in these groups. Empty means any group the bot is in.                       |
| `ALLOWLIST`                                               | empty                              | Extra people who can start meetings: phone numbers or JIDs, comma-separated             |
| `ALLOW_GROUP_ADMINS`                                      | `true`                             | Group admins can start meetings                                                         |
| `HOST`, `PORT`                                            | `127.0.0.1`, `3000`                | Where the webhook server listens                                                        |
| `WEBHOOK_PATH`                                            | `/zoom/webhook`                    | Webhook URL path                                                                        |
| `SUMMARY_ENABLED`                                         | `true`                             | AI summaries on or off                                                                  |
| `ANTHROPIC_API_KEY`                                       | empty                              | Claude API key. No key means no summaries.                                              |
| `SUMMARY_MODEL`                                           | `claude-sonnet-5-5`                | Claude model for summaries                                                              |
| `SUMMARY_EFFORT`                                          | `medium`                           | `low`, `medium`, `high`, `xhigh` or `max`                                               |
| `SUMMARY_FALLBACKS`                                       | `true`                             | If the model declines, the API retries on Anthropic's recommended fallback model        |
| `SUMMARY_MAX_CHARS`                                       | `1500`                             | Longest summary                                                                         |
| `RECORDING_RETENTION_DAYS`                                | `7`                                | Days after the transcript is posted before Zoom recordings are deleted                  |
| `RECORDING_DELETE_ACTION`                                 | `delete`                           | `delete` is permanent. `trash` uses Zoom's trash, which keeps files 30 days.            |
| `EXPIRE_AFTER_MINUTES`                                    | `120`                              | Unused links expire after this                                                          |
| `MIN_INSTANCE_MINUTES`                                    | `2`                                | Shorter parts are dropped                                                               |
| `TRANSCRIPT_GIVE_UP_HOURS`                                | `24`                               | Stop waiting for a transcript after this                                                |
| `PIN_SECONDS`                                             | `86400`                            | Pin time: 86400 (24h), 604800 (7 days) or 2592000 (30 days)                             |
| `TIMEZONE`                                                | `Europe/Dublin`                    | For times in `/zoom status`                                                             |
| `DEFAULT_TITLE`                                           | `Group call`                       | Title when none is given                                                                |
| `LOG_LEVEL`                                               | `info`                             | pino log level                                                                          |

### 6. Pair WhatsApp

This has to be done by hand. Put the bot's SIM in a phone and install WhatsApp on it.

**By QR code:** run the bot in a terminal the first time, so you can see the QR code:

```
sudo -u zoombot bash -c 'set -a; source /etc/whatsapp-zoom-bot/env; set +a; DATA_DIR=/var/lib/whatsapp-zoom-bot node /opt/whatsapp-zoom-bot/dist/main.js'
```

(Create `/var/lib/whatsapp-zoom-bot` first if the service has never run: `sudo install -d -o zoombot -g zoombot -m 700 /var/lib/whatsapp-zoom-bot`.)

On the bot's phone, open WhatsApp > Settings > Linked devices > Link a device, and scan the code. When the log says "WhatsApp connected", stop it with Ctrl+C.

**By pairing code:** set `WA_PAIRING_NUMBER` to the bot's number (digits with country code, like `353871234567`). Run the same command. The log prints an 8-character code. On the phone, open Linked devices > Link a device > Link with phone number instead, and type the code.

Then start the service:

```
sudo systemctl enable --now whatsapp-zoom-bot
journalctl -u whatsapp-zoom-bot -f
```

If the log says "WhatsApp logged out", delete `/var/lib/whatsapp-zoom-bot/baileys-auth` and pair again.

### 7. Add the bot to the group

1. Add the bot's number to the group.
2. **Make it a group admin.** WhatsApp only lets admins pin messages. If the bot isn't an admin, it posts once asking to be made one and carries on without pinning.
3. Type `/zoom help` in the group. The log line "command received" shows the group's JID. Put it in `GROUP_JIDS` if you want the bot to answer only there.
4. Post a short message explaining the bot and that meetings are recorded. Pin it, or add it to the group description.

Try it in a test group first.

## Commands

| Command                  | Who can use it                       | What happens                                                                                               |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `/zoom [title]`          | Group admins and the allowlist       | Creates a recorded meeting and posts the link. If one is already open in the group, it re-posts that link. |
| `/zoom norecord [title]` | Group admins and the allowlist       | Same, but not recorded, so no transcript.                                                                  |
| `/zoom end`              | Whoever started it, or a group admin | Ends the live meeting. If nobody has joined yet, it cancels the link.                                      |
| `/zoom status`           | Anyone                               | Says whether a meeting is live, who started it and when.                                                   |
| `/zoom help`             | Anyone                               | Lists the commands.                                                                                        |

If someone who isn't allowed types `/zoom`, the bot replies once: "Ask an admin to add you." After that it ignores them.

Only one meeting can be open per group. The bot has one Zoom host user, so only one meeting can be open across all groups. A second group gets "try again when it ends".

## How it works

```
src/
  main.ts            wires everything together
  config.ts          env settings, checked with zod
  db.ts              SQLite: meetings, instances, webhook inbox, one-time notices
  lifecycle.ts       the state machine, commands and sweepers
  commands.ts        command parsing, allowlist and sender matching
  messages.ts        every message the bot posts
  server.ts          Fastify webhook endpoint
  sweepers.ts        timers for the periodic jobs
  transcript.ts      VTT to plain text
  summary.ts         Claude summaries
  hostkey.ts         random host keys and passcodes
  zoom/client.ts     Zoom REST API (Server-to-Server OAuth)
  zoom/signature.ts  x-zm-signature checks and URL validation
  zoom/uuid.ts       UUID double-encoding
  whatsapp/types.ts  the WhatsApp interface the core uses
  whatsapp/baileys.ts  the Baileys implementation
```

**States.** A meeting goes `created` → `live` → `ended` → `done`. A link nobody uses for 2 hours becomes `expired`, and the bot deletes the Zoom meeting. A rejoin after the end takes it from `ended` back to `live`, with a new instance.

**Webhooks.** Each verified webhook is saved to SQLite before it is handled. The key is the event type plus the instance UUID, so duplicates are ignored. Saved webhooks are handled in order. If one fails (say WhatsApp is reconnecting), it is retried every minute, up to 5 times. The bot posts to WhatsApp before saving the new state, so a failure never leaves a half-done step. Zoom also retries webhooks that don't get a 200.

**Sweepers.** These catch anything a webhook missed:

- Every 15 minutes, the bot asks Zoom about each open meeting (`GET /meetings/{id}`). A finished meeting is treated as ended. A started one it didn't hear about is treated as live. Unused links older than 2 hours expire.
- Every 30 minutes, it polls `GET /meetings/{uuid}/recordings` for ended parts with no transcript yet. After 24 hours it posts "No transcript available".
- Every hour, it deletes Zoom recordings past the retention time.

## Decisions on the spec's open items

| Open item                                 | Decision                                                                                                                                                                                | Setting                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Who is on the allowlist?                  | WhatsApp group admins, plus an optional list of phone numbers or JIDs                                                                                                                   | `ALLOW_GROUP_ADMINS`, `ALLOWLIST`                       |
| Which LLM writes summaries?               | Anthropic Claude API, through the official `@anthropic-ai/sdk`. Default model `claude-sonnet-5-5`. Labelled "AI summary". With summaries off or no key, the transcript is posted alone. | `SUMMARY_ENABLED`, `ANTHROPIC_API_KEY`, `SUMMARY_MODEL` |
| How long to keep cloud recordings?        | 7 days after the transcript is posted                                                                                                                                                   | `RECORDING_RETENTION_DAYS`                              |
| Rotate the host key per meeting?          | Yes, by default. If the update fails, no key is sent and the requester is told host claim isn't available.                                                                              | `HOST_KEY_ROTATION`                                     |
| Is the Zoom account Pro, and who owns it? | Not a code question. Benji to confirm.                                                                                                                                                  | —                                                       |

## Where this differs from the spec

- **Extra database columns and tables.** The spec's two tables are there as written, plus: `meetings.requester_alt`, `requester_name` and `started_at` (for DMs, permissions and `/zoom status`); `instances.outcome` and `recording_deleted_at` (to finish each part and run retention); an `inbox` table (the webhook queue); and a `notices` table (one-time messages). Transcript text is never stored.
- **"Webhooks are queued while the bot is offline."** The bot can't receive anything while its process is down. Instead, Zoom retries failed deliveries, webhooks that arrive while WhatsApp is disconnected are saved and replayed in order, and the sweepers catch whatever is left.
- **`/zoom end` before anyone joins** cancels the link and deletes the Zoom meeting (state `expired`). The spec doesn't cover this case.
- **A missed `meeting.ended`.** When the sweeper finds a finished meeting, it uses the time of the sweep as the end time. The duration in "Meeting ended" may be up to 15 minutes too long.
- **"Part N" labels.** A part is only numbered when there is more than one. If the first transcript is posted before anyone rejoins, it has no number, and the next one is "Part 2".
- **Summary and transcript in one message.** The summary is the caption of the `.txt` file, quoting the original link message.
- **Extra Zoom scopes.** Ending, deleting meetings, deleting recordings and setting the host key need scopes the spec doesn't list. See the scope table.
- **Signed URL validation.** The bot requires a valid signature on Zoom's `endpoint.url_validation` request too. Otherwise anyone could use the endpoint to sign messages with your secret.

## Development

```
npm install
npm test          # Vitest
npm run typecheck # tsc
npm run lint      # Biome
npm run build
```

`npm run dev` runs from source with `tsx`, reading `.env` if there is one.

The core never talks to WhatsApp directly. It uses the `ChatPort` interface in `src/whatsapp/types.ts`. The tests use an in-memory fake for it and for Zoom, so they need no network and no phone.

What the tests can't cover, and you must check by hand: pairing WhatsApp, pinning and unpinning in a real group, and everything in the Zoom smoke test.

## License

MIT. See [LICENSE](LICENSE).
