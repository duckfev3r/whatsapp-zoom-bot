import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { signZoomBody } from "../src/zoom/signature.js";

const secret = "whsec";
const nowMs = 1_800_000_000_000;

function setup() {
  const events: unknown[] = [];
  const app = buildServer({
    secret,
    path: "/zoom/webhook",
    now: () => nowMs,
    onEvent: async (b) => {
      events.push(b);
    },
  });
  const post = (body: unknown, opts: { ts?: number; sig?: string } = {}) => {
    const raw = JSON.stringify(body);
    const ts = String(Math.floor((opts.ts ?? nowMs) / 1000));
    return app.inject({
      method: "POST",
      url: "/zoom/webhook",
      headers: {
        "content-type": "application/json",
        "x-zm-request-timestamp": ts,
        "x-zm-signature": opts.sig ?? signZoomBody(secret, raw, ts),
      },
      payload: raw,
    });
  };
  return { app, events, post };
}

describe("webhook server", () => {
  it("answers endpoint.url_validation", async () => {
    const { post, events } = setup();
    const res = await post({ event: "endpoint.url_validation", payload: { plainToken: "abc123" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      plainToken: "abc123",
      encryptedToken: crypto.createHmac("sha256", secret).update("abc123").digest("hex"),
    });
    expect(events).toHaveLength(0);
  });

  it("refuses url_validation without a valid signature", async () => {
    const { post } = setup();
    const res = await post(
      { event: "endpoint.url_validation", payload: { plainToken: "abc" } },
      { sig: "v0=deadbeef" },
    );
    expect(res.statusCode).toBe(401);
  });

  it("passes verified events on", async () => {
    const { post, events } = setup();
    const body = { event: "meeting.started", payload: { object: { id: 1, uuid: "u" } } };
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    expect(events).toEqual([body]);
  });

  it("rejects a bad signature", async () => {
    const { post, events } = setup();
    const res = await post({ event: "meeting.started" }, { sig: "v0=0000" });
    expect(res.statusCode).toBe(401);
    expect(events).toHaveLength(0);
  });

  it("rejects a stale request", async () => {
    const { post, events } = setup();
    const res = await post({ event: "meeting.started" }, { ts: nowMs - 6 * 60_000 });
    expect(res.statusCode).toBe(401);
    expect(events).toHaveLength(0);
  });

  it("rejects missing headers", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/zoom/webhook",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
  });

  it("has a health check", async () => {
    const { app } = setup();
    expect((await app.inject({ url: "/healthz" })).json()).toEqual({ ok: true });
  });
});
