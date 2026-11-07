import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { errorMessage, type Logger } from "./logger.js";
import { extractMessages, webhookSchema, type InboundMessage } from "./whatsapp/payload.js";
import { isValidSignature } from "./whatsapp/signature.js";

export interface ServerOptions {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
  /** Must return quickly: Meta expects a 200 within a few seconds, so real work is queued. */
  onMessages(messages: InboundMessage[]): number;
  logger: Logger;
  /** Extra routes (admin, simulator), registered before the error handler. */
  mount?: (app: express.Express) => void;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createApp(opts: ServerOptions): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Meta's one-time subscription check when the webhook URL is saved in the app dashboard.
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && typeof token === "string" && safeEqual(token, opts.verifyToken) && typeof challenge === "string") {
      res.type("text/plain").send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  // Raw body: the signature is computed over the exact bytes Meta sent.
  app.post("/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!isValidSignature(raw, req.get("x-hub-signature-256"), opts.appSecret)) {
      opts.logger.warn("webhook rejected: bad signature");
      res.sendStatus(401);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }

    const parsed = webhookSchema.safeParse(json);
    if (!parsed.success) {
      // Signed but not a shape we handle (another product's event). Acknowledge so Meta does not retry it.
      opts.logger.warn("webhook ignored: unexpected payload", { issues: parsed.error.issues.length });
      res.sendStatus(200);
      return;
    }

    const messages = extractMessages(parsed.data).filter((m) => m.phoneNumberId === opts.phoneNumberId);
    const accepted = messages.length > 0 ? opts.onMessages(messages) : 0;
    opts.logger.info("webhook received", { messages: messages.length, accepted });
    res.sendStatus(200);
  });

  opts.mount?.(app);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : 500;
    if (status >= 500) opts.logger.error("request failed", { error: errorMessage(err) });
    res.sendStatus(status);
  });

  return app;
}
