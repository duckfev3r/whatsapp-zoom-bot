import crypto from "node:crypto";

export const MAX_SKEW_MS = 5 * 60 * 1000;

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "bad" };

function hmac(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Checks Zoom's x-zm-signature header: "v0=" + HMAC-SHA256(secret, "v0:{timestamp}:{raw body}").
 * Rejects requests whose x-zm-request-timestamp (seconds) is more than 5 minutes off.
 */
export function verifyZoomSignature(opts: {
  secret: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  nowMs: number;
}): VerifyResult {
  const { secret, rawBody, signature, timestamp, nowMs } = opts;
  if (!signature || !timestamp) return { ok: false, reason: "missing" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad" };
  if (Math.abs(nowMs - ts * 1000) > MAX_SKEW_MS) return { ok: false, reason: "stale" };
  const expected = `v0=${hmac(secret, `v0:${timestamp}:${rawBody}`)}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad" };
  return { ok: true };
}

/** Builds the reply to Zoom's endpoint.url_validation challenge. */
export function urlValidationResponse(
  secret: string,
  plainToken: string,
): { plainToken: string; encryptedToken: string } {
  return { plainToken, encryptedToken: hmac(secret, plainToken) };
}

/** Signs a body the way Zoom does. Used by tests and local tooling. */
export function signZoomBody(secret: string, rawBody: string, timestamp: string): string {
  return `v0=${hmac(secret, `v0:${timestamp}:${rawBody}`)}`;
}
