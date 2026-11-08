# WhatsApp Zoom Bot — Spec

2026-11-06 · Benji Gogan

> Copied from the Claude Doc "WhatsApp Zoom Bot — Spec". The decisions taken on the open items are in the README, under "Decisions on the spec's open items".

## Overview

A bot in our 20+ person WhatsApp group creates a Zoom meeting on request. It pins the link while the meeting is live, unpins it when the meeting ends, and posts a summary plus the full transcript once Zoom has processed it.

**Goals**

- Anyone on the allowlist can start a meeting from the group in one message.
- The live link is always the pinned message while a meeting runs, and nothing stale stays pinned.
- Everyone gets a summary and the transcript without anyone having to chase it.

**Assumptions**

- The bot uses Baileys (an unofficial WhatsApp Web client) on a dedicated SIM. Meta's official Groups API caps groups at 8 participants and can't pin messages, so it can't serve this group.
- We accept the ban risk this carries. This is a community group, not a paid product.
- Meetings are hosted by one licensed Zoom Pro user with cloud recording and audio transcripts turned on.
- No human host is expected to join. The design relies on join-before-host with auto cloud recording (see Zoom configuration).

## Commands and messages

Users type commands. The bot replies only to commands and Zoom events, so it never sends unprompted chatter.

| Command                  | Who                 | What happens                                                                                 |
| ------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `/zoom [title]`          | Allowlist           | Creates a meeting and posts the link. If one is already live, it re-posts that link instead. |
| `/zoom norecord [title]` | Allowlist           | Same, but with recording off, so there's no transcript.                                      |
| `/zoom end`              | Requester or admins | Ends the live meeting through the API, which unpins the link.                                |
| `/zoom status`           | Anyone              | Says whether a meeting is live, who started it and when.                                     |
| `/zoom help`             | Anyone              | Lists the commands.                                                                          |

**Messages the bot posts**

1. **On create:** "📹 _{title}_ — {join_url}. Started by {name}. This meeting is recorded, and the transcript will be shared here." The link includes the passcode.
2. **To the requester only:** the host key, with a note that they can use it to claim host if moderation is needed.
3. **On `meeting.started`:** the bot pins the create message for 24h. It doesn't post anything new.
4. **On `meeting.ended`:** the bot unpins and posts "Meeting ended ({duration}). Transcript to follow."
5. **On transcript ready:** a summary of 5–10 bullets plus action items, quoting the create message, with the full transcript attached as a `.txt` file.

## Architecture

One always-on process holds the WhatsApp socket and the Zoom webhook endpoint. Serverless hosting won't work, because Baileys needs a persistent connection.

_Diagram: architecture · one server, three parts — "One server bridges the group and Zoom; Zoom events drive every pin"._

```
+------------------+        +----------------------------------------+        +-------------------+
| WhatsApp group   |        | Bot server (one VPS)                   |        | Zoom (Pro)        |
| 20+ members      | <----> |  +----------------------------------+  |        | Meetings API      |
| commands in,     |        |  | Baileys client                   |  |        | cloud recording   |
| links out        |        |  | linked device; sends, pins,      |  |        | audio transcripts |
+------------------+        |  | unpins                           |  |        | webhooks out      |
                            |  +----------------------------------+  |        +-------------------+
                            |                  ^ v                   |           ^         |
                            |  +----------------------------------+  |           |         |
                            |  | Lifecycle core                   | -+-----------+         |
                            |  | state machine, allowlist, SQLite |  |                     |
                            |  +----------------------------------+  |                     |
                            |                  ^ v                   |                     |
                            |  +----------------------------------+  | <-------------------+
                            |  | Webhooks + sweepers              |  |
                            |  | verifies signatures, polls as    |  |        +-------------------+
                            |  | fallback                         | -+------> | LLM API           |
                            |  +----------------------------------+  |        | transcript        |
                            +----------------------------------------+        | summaries         |
                                                                              +-------------------+
```

Commands flow from the group through Baileys into the core, which calls the Zoom API. Every pin, unpin and transcript post is triggered by a Zoom webhook or by a sweeper's poll, never by a timer guessing what happened.

## Zoom configuration

The meeting records with no host present only if join-before-host and auto cloud recording are both on and the waiting room is off. Per Zoom staff, [automatic cloud recording also starts if participants join before the host](https://devforum.zoom.us/t/cloud-recordings-in-oauth-app/31292). It has to be cloud recording: [automatic local recording only starts when the host starts the meeting](https://community.zoom.com/t5/Meetings/auto-record-only-to-local-PC/m-p/165861). A [Recall.ai guide](https://www.recall.ai/blog/debugging-issues-with-automatic-cloud-recording) warns that it can fail because of account-level settings, so the smoke test in the build plan must confirm it.

**Account (one-time setup)**

- Zoom Pro or higher, with one licensed user as the bot's host.
- Cloud recording on, "Create audio transcript" on, and "Recording disclaimer" on.
- A Server-to-Server OAuth app with scopes `meeting:write:meeting:admin`, `meeting:read:meeting:admin`, `cloud_recording:read:list_recording_files:admin` and `cloud_recording:read:recording:admin`.
- Event subscriptions for `meeting.started`, `meeting.ended` and `recording.transcript_completed`, all sent to `https://<host>/zoom/webhook`. Verify the signature on every event.

**Create Meeting payload** (`POST /users/{hostId}/meetings`)

| Setting                           | Value                         | Why                                                                                       |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `type`                            | 1 (instant)                   | It's created on demand.                                                                   |
| `settings.join_before_host`       | true                          | No host will join.                                                                        |
| `settings.jbh_time`               | 0 (anytime)                   | The link is used straight away.                                                           |
| `settings.waiting_room`           | false                         | Join-before-host doesn't work while the waiting room is on.                               |
| `settings.auto_recording`         | `cloud` (`none` for norecord) | This is what produces the transcript.                                                     |
| `settings.mute_upon_entry`        | true                          | It keeps order without a host.                                                            |
| `settings.meeting_authentication` | false                         | Group members may not have Zoom accounts.                                                 |
| `password`                        | random 6 to 10 characters     | The passcode is embedded in `join_url`. It keeps out people who only have the meeting ID. |

**Host fallback.** Alternative hosts must be licensed users on the same account, which group members aren't. The bot privately messages the requester the account's host key instead. Claiming host gives them mute, remove and stop-recording controls.

## Data model and states

State lives in SQLite in two tables. One Zoom meeting can have several instances, because each time the room empties and someone rejoins, Zoom starts a new instance with a new UUID and a new recording.

```sql
CREATE TABLE meetings (
  id              INTEGER PRIMARY KEY,
  zoom_meeting_id TEXT NOT NULL UNIQUE,
  group_jid       TEXT NOT NULL,
  title           TEXT,
  join_url        TEXT NOT NULL,
  record          INTEGER NOT NULL DEFAULT 1,
  requested_by    TEXT NOT NULL,   -- WhatsApp JID
  wa_msg_key      TEXT NOT NULL,   -- JSON of the create message key (needed to pin/unpin)
  status          TEXT NOT NULL,   -- created | live | ended | done | expired
  created_at      TEXT NOT NULL,
  ended_at        TEXT
);

CREATE TABLE instances (
  uuid            TEXT PRIMARY KEY,   -- Zoom meeting instance UUID
  meeting_id      INTEGER NOT NULL REFERENCES meetings(id),
  started_at      TEXT, ended_at TEXT,
  transcript_at   TEXT,               -- set when the transcript was posted
  attempts        INTEGER NOT NULL DEFAULT 0
);
```

| From    | Event                                     | To      | Bot action                                                        |
| ------- | ----------------------------------------- | ------- | ----------------------------------------------------------------- |
| —       | `/zoom`                                   | created | Create the Zoom meeting, post the link, DM the host key           |
| created | `meeting.started`                         | live    | Pin the create message for 24h, insert an instance row            |
| created | 2h with no start                          | expired | Delete the Zoom meeting and reply "link expired"                  |
| live    | `meeting.ended`                           | ended   | Unpin and post "Transcript to follow"                             |
| ended   | `meeting.started` (rejoin)                | live    | Pin again and add a new instance row                              |
| ended   | every instance transcribed, or 24h passed | done    | Post "no transcript available" for any instance still missing one |

Only one meeting per group can be in `created` or `live` at a time. One host user can also only run one meeting at once, so a second group asking for a meeting while one is live is refused.

## Edge cases

Each failure mode has a fallback, so the group is never left with a stale pin or a missing transcript.

| Case                                           | Handling                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `meeting.ended` never arrives                  | The pin expires after 24h anyway. Every 15 minutes, a sweeper calls `GET /meetings/{id}` and treats a finished meeting as ended.              |
| `recording.transcript_completed` never arrives | Every 30 minutes, a sweeper polls `GET /meetings/{uuid}/recordings` for instances that ended but have no transcript. It gives up after 24h.   |
| Several instances (people left and rejoined)   | Post one transcript per instance, labelled "Part 1", "Part 2" and so on. Drop instances shorter than 2 minutes, which are usually link tests. |
| Instance UUID starts with `/` or contains `//` | Double URL-encode the UUID before calling the recordings API.                                                                                 |
| Transcript is long                             | The message carries an LLM summary of at most about 1,500 characters. The full text goes in a `.txt` attachment.                              |
| Bot restarts mid-meeting                       | The Baileys auth state and SQLite both persist. Webhooks that arrive while the bot is offline are queued and replayed in order.               |
| Bot isn't a group admin                        | Pinning fails, so the bot posts once asking to be made an admin and carries on unpinned.                                                      |
| Duplicate webhooks                             | Handlers are idempotent, keyed on event type plus UUID.                                                                                       |
| Someone outside the allowlist sends `/zoom`    | The bot replies once: "Ask an admin to add you."                                                                                              |

## Security, privacy and risks

The biggest risk is a ban on the bot's number. The biggest obligation is recording consent under GDPR.

| Risk                                      | Mitigation                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WhatsApp bans the bot number (ToS breach) | Use a dedicated prepaid SIM. Keep volume low and only send when triggered. If banned, switch to a new number and re-pair. The group itself is unaffected.                      |
| Uninvited people get into the meeting     | Embed the passcode in the link, so the meeting ID alone isn't enough. The requester gets the host key for moderation. Reset the host key regularly.                            |
| Recording without valid consent (GDPR)    | The create message states that the meeting is recorded. Zoom's recording disclaimer appears on join. Add a `norecord` option. Pin a group-description note explaining the bot. |
| Transcripts kept indefinitely             | Delete Zoom cloud recordings 7 days after the transcript is posted. Don't store transcript text in SQLite.                                                                     |
| Leaked credentials                        | Keep Zoom secrets and the Baileys auth folder outside the repo, readable only by the service user.                                                                             |
| Forged webhooks                           | Verify `x-zm-signature` with HMAC-SHA256 and the app's secret token, and reject anything older than 5 minutes.                                                                 |
| Summary misrepresents the meeting         | Label it "AI summary" and always attach the full transcript.                                                                                                                   |

## Build plan

The first step is a 10-minute smoke test on the real Zoom account. It confirms the host-less recording assumption before any code depends on it.

1. **Smoke test (before coding).** Create a meeting through the API with the settings in Zoom configuration. Join from two devices without the host account, talk for 3 minutes, then leave. Check that a cloud recording and a VTT transcript appear, and that `recording.transcript_completed` fires. If no recording appears, check the account-level recording settings. As a last resort, the bot's host joins through a headless Zoom client.
2. **WhatsApp layer.** Pair Baileys, persist the auth state, parse commands in one test group, and post, pin and unpin a test message.
3. **Zoom layer.** Get Server-to-Server OAuth tokens, create and delete meetings, add the webhook endpoint with signature checks, and set up the SQLite schema.
4. **Lifecycle.** Wire up the state transitions, idempotent handlers and both sweepers.
5. **Transcripts.** Download the VTT, strip it to plain text, write the LLM summary, and upload the `.txt` attachment.
6. **Hardening.** Add the allowlist, the norecord option, the retention job, a systemd service and log rotation.
7. **Go live.** Add the bot to the real group, make it an admin, and post a one-message explanation.

**Stack:** Node 22 and TypeScript, Baileys, Fastify, better-sqlite3, and an LLM API for summaries. It runs on one small VPS behind Caddy for HTTPS, at roughly 400–600 lines of code.

**Open items**

- [ ] Is the Zoom account already Pro, and who owns it?
- [ ] Who is on the allowlist: group admins only, or a named list?
- [ ] Which LLM provider should write summaries, and is it OK to send transcripts to it?
- [ ] How long to keep cloud recordings (7 days proposed)?

- [ ] Rotate the host key for each meeting? The host key is a static 6-digit PIN that lets anyone claim host in every meeting run by the bot's host user. If the bot hands out one fixed key, every past requester could take over every future meeting. Proposal: before each meeting, set a new random `host_key` through Zoom's Update User API (`PATCH /users/{userId}`), DM it only to the requester, and never store it in plain text. Because only one meeting is live at a time, the key works for that meeting only. To confirm in the smoke test: the API accepts the change and which OAuth scope it needs.
