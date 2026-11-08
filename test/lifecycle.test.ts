import { describe, expect, it } from "vitest";
import * as msg from "../src/messages.js";
import { ADMIN, ALICE, BOB, GROUP, Harness, OTHER_GROUP, SAMPLE_VTT } from "./fakes.js";

const ALICE_DM = ALICE.alt as string;

describe("/zoom start", () => {
  it("creates a recorded meeting, posts the link and DMs a fresh host key", async () => {
    const h = new Harness();
    const id = await h.startMeeting("/zoom Weekly sync");
    const m = h.meeting(id);
    expect(m.status).toBe("created");
    expect(m.record).toBe(1);
    expect(m.title).toBe("Weekly sync");
    expect(h.zoom.created[0]).toMatchObject({ topic: "Weekly sync", record: true });
    expect(h.zoom.created[0]?.passcode).toMatch(/^[A-Za-z0-9]{8}$/);

    const post = h.chat.last(GROUP);
    expect(post?.text).toBe(
      `📹 _Weekly sync_ — ${m.join_url}. Started by Alice. This meeting is recorded, and the transcript will be shared here.`,
    );
    expect(JSON.parse(m.wa_msg_key)).toEqual(post?.key);

    expect(h.zoom.hostKeys).toHaveLength(1);
    const key = h.zoom.hostKeys[0] as string;
    expect(key).toMatch(/^\d{6}$/);
    const dm = h.chat.last(ALICE_DM);
    expect(dm?.text).toContain(key);
    // The key only ever goes to the requester, and is never stored.
    expect(h.chat.textsTo(GROUP).some((t) => t.includes(key))).toBe(false);
    expect(JSON.stringify(h.store.db.prepare("SELECT * FROM meetings").all())).not.toContain(key);
  });

  it("uses the default title", async () => {
    const h = new Harness();
    const id = await h.startMeeting("/zoom");
    expect(h.meeting(id).title).toBe("Group call");
  });

  it("creates an unrecorded meeting for norecord", async () => {
    const h = new Harness();
    const id = await h.startMeeting("/zoom norecord Private");
    expect(h.zoom.created[0]).toMatchObject({ topic: "Private", record: false });
    expect(h.meeting(id).record).toBe(0);
    expect(h.chat.last(GROUP)?.text).toContain("This meeting is not recorded.");
  });

  it("says host claim is unavailable when the host key PATCH fails", async () => {
    const h = new Harness();
    h.zoom.failHostKey = true;
    await h.startMeeting();
    const dm = h.chat.last(ALICE_DM)?.text ?? "";
    expect(dm).toBe(msg.hostKeyUnavailable("Weekly sync"));
    expect(dm).not.toMatch(/\d{6}/);
    expect(h.chat.last(GROUP)?.text).toContain("📹"); // the meeting still goes ahead
  });

  it("sends no host key when rotation is off", async () => {
    const h = new Harness({ hostKeyRotation: false });
    await h.startMeeting();
    expect(h.zoom.hostKeys).toHaveLength(0);
    expect(h.chat.textsTo(ALICE_DM)).toHaveLength(0);
  });

  it("tells the group when Zoom fails", async () => {
    const h = new Harness();
    h.zoom.failCreate = true;
    await h.say(ALICE, "/zoom");
    expect(h.chat.last(GROUP)?.text).toBe(msg.CREATE_FAILED);
    expect(h.store.activeMeeting(GROUP)).toBeUndefined();
  });

  it("deletes the Zoom meeting if the link can't be posted", async () => {
    const h = new Harness();
    h.chat.failNextSend = 1;
    await expect(h.say(ALICE, "/zoom")).rejects.toThrow();
    expect(h.zoom.deleted).toEqual(["1001"]);
    expect(h.store.activeMeeting(GROUP)).toBeUndefined();
  });
});

describe("permissions", () => {
  it("lets allowlisted users and group admins start meetings", async () => {
    const h = new Harness();
    await h.startMeeting("/zoom", GROUP, ALICE);
    await h.startMeeting("/zoom", OTHER_GROUP, ADMIN).catch(() => undefined);
    expect(h.zoom.created).toHaveLength(1); // second refused only by the one-host rule
    expect(h.chat.last(OTHER_GROUP)?.text).toBe(msg.HOST_BUSY);
  });

  it("lets a group admin start a meeting", async () => {
    const h = new Harness({ allowlist: [] });
    await h.startMeeting("/zoom", GROUP, ADMIN);
    expect(h.zoom.created).toHaveLength(1);
  });

  it("can ignore group admins", async () => {
    const h = new Harness({ allowlist: [], allowGroupAdmins: false });
    await h.say(ADMIN, "/zoom");
    expect(h.zoom.created).toHaveLength(0);
    expect(h.chat.last(GROUP)?.text).toBe(msg.NOT_ALLOWED);
  });

  it("replies 'Ask an admin to add you.' once per person", async () => {
    const h = new Harness();
    await h.say(BOB, "/zoom");
    await h.say(BOB, "/zoom again");
    expect(h.chat.textsTo(GROUP)).toEqual([msg.NOT_ALLOWED]);
    expect(h.zoom.created).toHaveLength(0);
  });

  it("lets anyone use status and help", async () => {
    const h = new Harness();
    await h.say(BOB, "/zoom help");
    await h.say(BOB, "/zoom status");
    expect(h.chat.textsTo(GROUP)).toEqual([msg.HELP, msg.NO_MEETING]);
  });

  it("only answers in configured groups", async () => {
    const h = new Harness({ groupJids: [OTHER_GROUP] });
    await h.say(ALICE, "/zoom help", GROUP);
    expect(h.chat.sent).toHaveLength(0);
  });

  it("lets the requester or an admin end, and refuses others", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.started(id, "u1");

    await h.say(BOB, "/zoom end");
    expect(h.chat.last(GROUP)?.text).toBe(msg.onlyRequesterCanEnd("Alice"));
    expect(h.zoom.ended).toEqual([]);

    await h.say(ADMIN, "/zoom end");
    expect(h.zoom.ended).toEqual([id]);

    await h.say({ ...ALICE, jid: "different@lid" }, "/zoom end"); // matched by phone JID
    expect(h.zoom.ended).toEqual([id, id]);
  });
});

describe("one active meeting", () => {
  it("re-posts the open link instead of creating another", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const url = h.meeting(id).join_url;
    await h.say(ALICE, "/zoom Another");
    expect(h.zoom.created).toHaveLength(1);
    const last = h.chat.last(GROUP);
    expect(last?.text).toBe(`${msg.ALREADY_ACTIVE} ${url}`);
    expect(last?.quote?.key).toEqual(JSON.parse(h.meeting(id).wa_msg_key));
  });

  it("refuses a second group while the host is busy, then allows it after", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.say(ALICE, "/zoom", OTHER_GROUP);
    expect(h.chat.last(OTHER_GROUP)?.text).toBe(msg.HOST_BUSY);

    const start = h.iso();
    await h.started(id, "u1");
    h.advance(10);
    await h.ended(id, "u1", start);
    await h.startMeeting("/zoom", OTHER_GROUP);
    expect(h.zoom.created).toHaveLength(2);
  });
});

describe("state transitions", () => {
  it("created -> live on meeting.started: pins for 24h and adds an instance", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const before = h.chat.sent.length;
    await h.started(id, "u1");
    const m = h.meeting(id);
    expect(m.status).toBe("live");
    expect(m.started_at).toBe(h.iso());
    expect(h.chat.pins).toEqual([{ group: GROUP, key: JSON.parse(m.wa_msg_key), seconds: 86400 }]);
    expect(h.store.instances(m.id).map((i) => i.uuid)).toEqual(["u1"]);
    expect(h.chat.sent.length).toBe(before); // posts nothing new
  });

  it("live -> ended on meeting.ended: unpins and says a transcript follows", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(42);
    await h.ended(id, "u1", start);
    const m = h.meeting(id);
    expect(m.status).toBe("ended");
    expect(h.chat.unpins).toHaveLength(1);
    expect(h.chat.last(GROUP)?.text).toBe("Meeting ended (42 min). Transcript to follow.");
  });

  it("ended -> live on a rejoin: pins again with a new instance", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const s1 = h.iso();
    await h.started(id, "u1");
    h.advance(10);
    await h.ended(id, "u1", s1);
    h.advance(5);
    await h.started(id, "u2");
    expect(h.meeting(id).status).toBe("live");
    expect(h.chat.pins).toHaveLength(2);
    expect(h.store.instances(h.meeting(id).id).map((i) => i.uuid)).toEqual(["u1", "u2"]);
  });

  it("ended -> done when every instance has a transcript", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    h.advance(20);
    await h.transcript(id, "u1");

    expect(h.meeting(id).status).toBe("done");
    const doc = h.chat.last(GROUP);
    expect(doc?.doc?.fileName).toBe("weekly-sync-2026-11-08.txt");
    expect(doc?.doc?.mimetype).toBe("text/plain");
    expect(doc?.doc?.data.toString()).toContain("Alice: Hello everyone. Let's start.");
    expect(doc?.text).toContain("*AI summary* — Weekly sync");
    expect(doc?.quote?.key).toEqual(JSON.parse(h.meeting(id).wa_msg_key));
    expect(h.store.instance("u1")?.transcript_at).toBe(h.iso());
  });

  it("created -> expired after 2h with no start: deletes the meeting and replies", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    h.advance(119);
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("created");

    h.advance(1);
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("expired");
    expect(h.zoom.deleted).toEqual([id]);
    const last = h.chat.last(GROUP);
    expect(last?.text).toBe(msg.EXPIRED);
    expect(last?.quote?.key).toEqual(JSON.parse(h.meeting(id).wa_msg_key));
    expect(h.store.activeMeeting(GROUP)).toBeUndefined();
  });

  it("ignores events for expired meetings", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    h.advance(121);
    await h.bot.sweepMeetings();
    await h.started(id, "late");
    expect(h.meeting(id).status).toBe("expired");
    expect(h.chat.pins).toHaveLength(0);
  });

  it("ended -> done after 24h with no transcript, posting 'no transcript available'", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    h.advance(23 * 60);
    await h.bot.sweepTranscripts();
    expect(h.meeting(id).status).toBe("ended");

    h.advance(60);
    await h.bot.sweepTranscripts();
    expect(h.meeting(id).status).toBe("done");
    expect(h.chat.last(GROUP)?.text).toBe(msg.noTranscript("Weekly sync", null));
    expect(h.store.instance("u1")?.outcome).toBe("missing");
  });

  it("goes straight to done for norecord meetings", async () => {
    const h = new Harness();
    const id = await h.startMeeting("/zoom norecord");
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(15);
    await h.ended(id, "u1", start);
    expect(h.meeting(id).status).toBe("done");
    expect(h.chat.last(GROUP)?.text).toBe("Meeting ended (15 min).");
  });

  it("/zoom end on an unused link cancels it", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.say(ALICE, "/zoom end");
    expect(h.meeting(id).status).toBe("expired");
    expect(h.zoom.deleted).toEqual([id]);
    expect(h.chat.last(GROUP)?.text).toBe(msg.CANCELLED);
  });

  it("/zoom status reports who started the meeting and when", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.started(id, "u1");
    await h.say(BOB, "/zoom status");
    expect(h.chat.last(GROUP)?.text).toBe(
      `A meeting is live: _Weekly sync_, started by Alice at Sun 10:00. ${h.meeting(id).join_url}`,
    );
  });
});

describe("idempotent webhooks", () => {
  it("ignores duplicate deliveries of the same event and UUID", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    expect(await h.started(id, "u1")).toBe(true);
    expect(await h.started(id, "u1")).toBe(false);
    expect(h.chat.pins).toHaveLength(1);

    h.advance(10);
    await h.ended(id, "u1", start);
    await h.ended(id, "u1", start);
    expect(h.chat.textsTo(GROUP).filter((t) => t.startsWith("Meeting ended"))).toHaveLength(1);

    await h.transcript(id, "u1");
    await h.transcript(id, "u1");
    expect(h.chat.sent.filter((s) => s.doc)).toHaveLength(1);
    expect(h.summarizer?.calls).toHaveLength(1);
  });

  it("doesn't double-post when the sweeper and a late webhook both end a meeting", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(20);
    h.zoom.statuses.set(id, { status: "finished" });
    await h.bot.sweepMeetings();
    await h.ended(id, "u1", start);
    expect(h.chat.textsTo(GROUP).filter((t) => t.startsWith("Meeting ended"))).toHaveLength(1);
  });

  it("ignores unknown meetings and events", async () => {
    const h = new Harness();
    expect(
      await h.webhook({ event: "meeting.started", payload: { object: { id: "999", uuid: "x" } } }),
    ).toBe(true);
    expect(await h.webhook({ event: "user.updated", payload: { object: { uuid: "y" } } })).toBe(
      false,
    );
    expect(h.chat.sent).toHaveLength(0);
  });

  it("keeps a webhook queued when handling fails, and replays it in order", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(10);
    h.chat.failNextSend = 2; // WhatsApp is down for the next two sends
    await h.ended(id, "u1", start);
    await h.transcript(id, "u1"); // queued behind the failed one
    expect(h.chat.sent.filter((s) => s.doc)).toHaveLength(0);

    expect(h.meeting(id).status).toBe("live"); // nothing saved for the failed event

    await h.bot.drainInbox();
    const texts = h.chat.textsTo(GROUP);
    const endedAt = texts.findIndex((t) => t.startsWith("Meeting ended"));
    const docAt = h.chat.sent.filter((s) => s.jid === GROUP).findIndex((s) => s.doc);
    expect(endedAt).toBeGreaterThan(-1);
    expect(docAt).toBeGreaterThan(endedAt); // replayed in order
    expect(h.meeting(id).status).toBe("done");
  });
});

describe("webhook queue", () => {
  it("drops a webhook after repeated failures so the queue keeps moving", async () => {
    const h = new Harness({ maxInboxAttempts: 2 });
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(10);
    h.chat.failNextSend = 2;
    await h.ended(id, "u1", start); // attempt 1 fails
    await h.bot.drainInbox(); // attempt 2 fails, given up
    const row = h.store.db.prepare("SELECT * FROM inbox WHERE key = ?").get("meeting.ended:u1") as {
      processed_at: string | null;
      error: string;
    };
    expect(row.processed_at).not.toBeNull();
    expect(row.error).toMatch(/gave up/);
    // The sweeper still closes the meeting.
    h.zoom.statuses.set(id, { status: "finished" });
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("ended");
  });
});

describe("instances", () => {
  it("drops instances under 2 minutes", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(1);
    await h.ended(id, "u1", start);
    expect(h.chat.last(GROUP)?.text).toBe("Meeting ended (1 min). It was too short to transcribe.");
    expect(h.store.instance("u1")?.outcome).toBe("short");
    expect(h.meeting(id).status).toBe("done");

    await h.transcript(id, "u1");
    expect(h.chat.sent.filter((s) => s.doc)).toHaveLength(0);
  });

  it("labels several instances Part 1, Part 2", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const s1 = h.iso();
    await h.started(id, "u1");
    h.advance(20);
    await h.ended(id, "u1", s1);
    h.advance(5);
    const s2 = h.iso();
    await h.started(id, "u2");
    h.advance(20);
    await h.ended(id, "u2", s2);

    await h.transcript(id, "u1");
    await h.transcript(id, "u2");
    const docs = h.chat.sent.filter((s) => s.doc);
    expect(docs.map((d) => d.doc?.fileName)).toEqual([
      "weekly-sync-2026-11-08-part-1.txt",
      "weekly-sync-2026-11-08-part-2.txt",
    ]);
    expect(docs[0]?.text).toContain("Weekly sync — Part 1");
    expect(docs[1]?.text).toContain("Weekly sync — Part 2");
    expect(h.meeting(id).status).toBe("done");
  });

  it("doesn't count a short rejoin as a part", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const s1 = h.iso();
    await h.started(id, "u1");
    h.advance(20);
    await h.ended(id, "u1", s1);
    const s2 = h.iso();
    await h.started(id, "u2");
    h.advance(1);
    await h.ended(id, "u2", s2);
    await h.transcript(id, "u1");
    expect(h.chat.sent.find((s) => s.doc)?.doc?.fileName).toBe("weekly-sync-2026-11-08.txt");
    expect(h.meeting(id).status).toBe("done");
  });
});

describe("pinning", () => {
  it("asks once to be made admin when pinning fails, and carries on", async () => {
    const h = new Harness();
    h.chat.botIsAdmin = false;
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    expect(h.chat.last(GROUP)?.text).toBe(msg.MAKE_ME_ADMIN);
    expect(h.meeting(id).status).toBe("live");

    h.advance(10);
    await h.ended(id, "u1", start);
    await h.started(id, "u2");
    expect(h.chat.textsTo(GROUP).filter((t) => t === msg.MAKE_ME_ADMIN)).toHaveLength(1);
  });
});

describe("summaries", () => {
  async function finished(h: Harness) {
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    await h.transcript(id, "u1");
    return h.chat.sent.find((s) => s.doc);
  }

  it("posts an AI summary with the transcript attached", async () => {
    const h = new Harness();
    const doc = await finished(h);
    expect(doc?.text).toBe(
      "📝 *AI summary* — Weekly sync\n\n• We talked.\nAction items: none\n\nFull transcript attached.",
    );
    expect(h.summarizer?.calls[0]?.transcript).toContain("Bob: Sounds good.");
  });

  it("posts the transcript alone when summaries are off", async () => {
    const h = new Harness({}, { summarizer: false });
    const doc = await finished(h);
    expect(doc?.text).toBe("📝 Transcript — Weekly sync");
    expect(doc?.doc).toBeDefined();
  });

  it("still posts the transcript when the summary fails", async () => {
    const h = new Harness();
    if (h.summarizer) h.summarizer.result = new Error("overloaded");
    const doc = await finished(h);
    expect(doc?.text).toContain("couldn't be written");
    expect(doc?.text).not.toContain("*AI summary*");
    expect(doc?.doc).toBeDefined();
  });

  it("never stores transcript text in SQLite", async () => {
    const h = new Harness();
    await finished(h);
    const dump = JSON.stringify(
      ["meetings", "instances", "notices", "inbox"].map((t) =>
        h.store.db.prepare(`SELECT * FROM ${t}`).all(),
      ),
    );
    expect(dump).not.toContain("Hello everyone");
  });
});

describe("sweepers", () => {
  it("meetings sweeper ends a live meeting whose meeting.ended was missed", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.started(id, "u1");
    h.zoom.statuses.set(id, { status: "started" });
    h.advance(15);
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("live");

    h.zoom.statuses.set(id, { status: "finished" });
    h.advance(15);
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("ended");
    expect(h.chat.unpins).toHaveLength(1);
    expect(h.chat.last(GROUP)?.text).toBe("Meeting ended (30 min). Transcript to follow.");
  });

  it("meetings sweeper treats a meeting Zoom no longer knows as ended", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    await h.started(id, "u1");
    h.zoom.statuses.delete(id);
    h.advance(15);
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("ended");
  });

  it("meetings sweeper catches a missed meeting.started", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    h.zoom.statuses.set(id, { status: "started", uuid: "u9", startTime: h.iso() });
    h.advance(150); // past the expiry time, but it is running
    await h.bot.sweepMeetings();
    expect(h.meeting(id).status).toBe("live");
    expect(h.chat.pins).toHaveLength(1);
    expect(h.store.instance("u9")).toBeDefined();
  });

  it("transcript sweeper fetches a transcript whose webhook was missed", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "/u1//x==");
    h.advance(30);
    await h.ended(id, "/u1//x==", start);

    await h.bot.sweepTranscripts(); // nothing ready yet
    expect(h.store.instance("/u1//x==")?.attempts).toBe(1);

    h.zoom.recordings.set("/u1//x==", [
      { fileType: "TRANSCRIPT", status: "completed", downloadUrl: "https://zoom.us/rec/t.vtt" },
    ]);
    h.zoom.files.set("https://zoom.us/rec/t.vtt", SAMPLE_VTT);
    h.advance(30);
    await h.bot.sweepTranscripts();
    expect(h.chat.sent.filter((s) => s.doc)).toHaveLength(1);
    expect(h.meeting(id).status).toBe("done");
    expect(h.store.instance("/u1//x==")?.attempts).toBe(2);
  });

  it("transcript sweeper waits while the transcript is still processing", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    h.zoom.recordings.set("u1", [
      { fileType: "TRANSCRIPT", status: "processing", downloadUrl: "https://zoom.us/rec/t.vtt" },
    ]);
    await h.bot.sweepTranscripts();
    expect(h.chat.sent.filter((s) => s.doc)).toHaveLength(0);
  });

  it("retention sweeper deletes recordings 7 days after the transcript is posted", async () => {
    const h = new Harness();
    const id = await h.startMeeting();
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    await h.transcript(id, "u1");

    h.advance(7 * 24 * 60 - 1);
    await h.bot.sweepRetention();
    expect(h.zoom.deletedRecordings).toEqual([]);

    h.advance(1);
    await h.bot.sweepRetention();
    expect(h.zoom.deletedRecordings).toEqual([{ uuid: "u1", action: "delete" }]);
    await h.bot.sweepRetention();
    expect(h.zoom.deletedRecordings).toHaveLength(1);
  });

  it("retention sweeper skips unrecorded meetings and respects the setting", async () => {
    const h = new Harness({ retentionDays: 1, deleteAction: "trash" });
    const id = await h.startMeeting("/zoom norecord");
    const start = h.iso();
    await h.started(id, "u1");
    h.advance(30);
    await h.ended(id, "u1", start);
    const id2 = await h.startMeeting();
    const s2 = h.iso();
    await h.started(id2, "u2");
    h.advance(30);
    await h.ended(id2, "u2", s2);
    await h.transcript(id2, "u2");
    h.advance(24 * 60);
    await h.bot.sweepRetention();
    expect(h.zoom.deletedRecordings).toEqual([{ uuid: "u2", action: "trash" }]);
  });
});
