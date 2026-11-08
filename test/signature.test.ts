import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { signZoomBody, urlValidationResponse, verifyZoomSignature } from "../src/zoom/signature.js";

const secret = "test-secret";
const body = JSON.stringify({ event: "meeting.started", payload: { object: { uuid: "abc" } } });
const nowMs = 1_800_000_000_000;
const ts = String(nowMs / 1000);

describe("verifyZoomSignature", () => {
  it("accepts a valid signature", () => {
    const signature = signZoomBody(secret, body, ts);
    expect(verifyZoomSignature({ secret, rawBody: body, signature, timestamp: ts, nowMs })).toEqual(
      {
        ok: true,
      },
    );
  });

  it("matches Zoom's documented formula", () => {
    const expected = `v0=${crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(signZoomBody(secret, body, ts)).toBe(expected);
  });

  it("rejects a bad signature", () => {
    const signature = signZoomBody("wrong", body, ts);
    expect(verifyZoomSignature({ secret, rawBody: body, signature, timestamp: ts, nowMs })).toEqual(
      {
        ok: false,
        reason: "bad",
      },
    );
  });

  it("rejects a tampered body", () => {
    const signature = signZoomBody(secret, body, ts);
    const r = verifyZoomSignature({ secret, rawBody: `${body} `, signature, timestamp: ts, nowMs });
    expect(r).toEqual({ ok: false, reason: "bad" });
  });

  it("rejects a stale timestamp (over 5 minutes)", () => {
    const old = String(nowMs / 1000 - 301);
    const signature = signZoomBody(secret, body, old);
    expect(
      verifyZoomSignature({ secret, rawBody: body, signature, timestamp: old, nowMs }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts a timestamp just inside the window", () => {
    const recent = String(nowMs / 1000 - 299);
    const signature = signZoomBody(secret, body, recent);
    expect(
      verifyZoomSignature({ secret, rawBody: body, signature, timestamp: recent, nowMs }).ok,
    ).toBe(true);
  });

  it("rejects missing headers", () => {
    expect(
      verifyZoomSignature({ secret, rawBody: body, signature: undefined, timestamp: ts, nowMs }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});

describe("urlValidationResponse", () => {
  it("returns the HMAC of the plain token", () => {
    const r = urlValidationResponse(secret, "qgg8vlvZRS6UYooatFL8Aw");
    expect(r.plainToken).toBe("qgg8vlvZRS6UYooatFL8Aw");
    expect(r.encryptedToken).toBe(
      crypto.createHmac("sha256", secret).update("qgg8vlvZRS6UYooatFL8Aw").digest("hex"),
    );
  });
});
