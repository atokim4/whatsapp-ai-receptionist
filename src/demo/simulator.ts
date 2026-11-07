import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { z } from "zod";
import { errorMessage, type Logger } from "../logger.js";
import { signBody } from "../whatsapp/signature.js";
import type { DemoOutbox } from "./outbox.js";

export interface SimulatorOptions {
  outbox: DemoOutbox;
  appSecret: string;
  phoneNumberId: string;
  clinicName: string;
  model: "demo" | "claude";
  publicDir: string;
  logger: Logger;
}

const sendSchema = z.strictObject({
  waId: z.string().regex(/^\d{6,15}$/, "waId must be 6-15 digits"),
  name: z.string().trim().min(1).max(60),
  text: z.string().trim().min(1).max(1000),
});
const threadQuery = z.object({ waId: z.string().regex(/^\d{6,15}$/), after: z.coerce.number().int().min(0).default(0) });

/** Builds the same JSON Meta sends for an incoming text message. */
export function inboundTextPayload(phoneNumberId: string, waId: string, name: string, text: string, now: Date) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "DEMO_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ wa_id: waId, profile: { name } }],
              messages: [
                {
                  id: `wamid.DEMO${randomUUID().replaceAll("-", "")}`,
                  from: waId,
                  timestamp: String(Math.floor(now.getTime() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Demo-only phone simulator. The page never sees the app secret: it posts plain text here, and the server
 * signs a Meta-shaped payload and sends it to its own /webhook over HTTP, so every message goes through
 * signature verification, parsing and deduplication like a real one.
 */
export function simulatorRouter(opts: SimulatorOptions): express.Router {
  const router = express.Router();

  router.get("/", (_req, res) => res.sendFile("simulator.html", { root: opts.publicDir }));

  router.get("/api/info", (_req, res) => {
    res.json({ clinicName: opts.clinicName, model: opts.model });
  });

  router.post("/api/send", express.json({ limit: "8kb" }), async (req, res) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    const { waId, name, text } = parsed.data;

    const body = JSON.stringify(inboundTextPayload(opts.phoneNumberId, waId, name, text, new Date()));
    // Call the webhook on the address this request came in on, so any HOST setting works.
    const { address, family, port } = req.socket.address() as AddressInfo;
    const host = family === "IPv6" ? `[${address}]` : address;
    const entry = opts.outbox.recordInbound(waId, text);
    try {
      const webhook = await fetch(`http://${host}:${port}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody(body, opts.appSecret) },
        body,
        signal: AbortSignal.timeout(5000),
      });
      res.status(webhook.ok ? 202 : 502).json({ entry, webhookStatus: webhook.status });
    } catch (err) {
      opts.logger.error("simulator could not reach the webhook", { error: errorMessage(err) });
      res.status(502).json({ error: "Webhook unreachable" });
    }
  });

  router.get("/api/thread", (req, res) => {
    const query = threadQuery.safeParse(req.query);
    if (!query.success) return void res.status(400).json({ error: "Expected ?waId=<digits>&after=<seq>" });
    res.json({ entries: opts.outbox.thread(query.data.waId, query.data.after) });
  });

  return router;
}
