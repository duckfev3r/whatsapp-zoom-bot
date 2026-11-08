import Fastify, { type FastifyInstance } from "fastify";
import { urlValidationResponse, verifyZoomSignature } from "./zoom/signature.js";

export interface WebhookServerOptions {
  secret: string;
  path: string;
  /** Called with each verified event. Should return quickly. */
  onEvent: (body: { event: string; payload?: unknown }) => Promise<unknown>;
  now?: () => number;
  logger?: boolean | object;
}

/**
 * The Zoom webhook endpoint. It checks x-zm-signature on every request, answers
 * Zoom's endpoint.url_validation challenge, and hands other events to `onEvent`.
 */
export function buildServer(opts: WebhookServerOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });
  const now = opts.now ?? Date.now;

  // Keep the raw body: the signature is computed over the exact bytes Zoom sent.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.post(opts.path, async (req, reply) => {
    const raw = typeof req.body === "string" ? req.body : "";
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const check = verifyZoomSignature({
      secret: opts.secret,
      rawBody: raw,
      signature: header("x-zm-signature"),
      timestamp: header("x-zm-request-timestamp"),
      nowMs: now(),
    });
    if (!check.ok) {
      req.log.warn({ reason: check.reason }, "rejected webhook");
      return reply.code(401).send({ error: "invalid signature" });
    }

    let body: { event?: unknown; payload?: { plainToken?: unknown } };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }

    if (body.event === "endpoint.url_validation") {
      const token = body.payload?.plainToken;
      if (typeof token !== "string") return reply.code(400).send({ error: "missing plainToken" });
      return reply.code(200).send(urlValidationResponse(opts.secret, token));
    }

    if (typeof body.event !== "string") return reply.code(400).send({ error: "missing event" });
    req.log.info({ event: body.event }, "webhook received");
    await opts.onEvent(body as { event: string });
    return reply.code(200).send({ ok: true });
  });

  return app;
}
