import express from "express";
import { z } from "zod";
import type { Clinic } from "../clinic/clinic.js";
import { localNow, toStamp } from "../clinic/time.js";
import { maskPhone, type Logger } from "../logger.js";
import type { Store } from "../store.js";
import type { Messenger } from "../whatsapp/messenger.js";
import { basicAuth } from "./basic-auth.js";

export interface AdminOptions {
  store: Store;
  clinic: Clinic;
  messenger: Messenger;
  user: string;
  password: string;
  publicDir: string;
  logger: Logger;
  now: () => Date;
}

const replySchema = z.strictObject({ text: z.string().trim().min(1).max(4096) });
const waIdParam = z.string().regex(/^\d{6,20}$/);
const idParam = z.coerce.number().int().positive();

/**
 * Staff dashboard: upcoming bookings, handoffs and conversations, plus "reply as staff" and "resolve".
 * JSON-only writes behind basic auth: a cross-site form cannot send application/json without a CORS preflight.
 */
export function adminRouter(opts: AdminOptions): express.Router {
  const { store, clinic, messenger, logger } = opts;
  const router = express.Router();
  router.use(basicAuth(opts.user, opts.password));
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  router.get("/", (_req, res) => res.sendFile("admin.html", { root: opts.publicDir }));

  router.get("/api/overview", (_req, res) => {
    const today = localNow(clinic.timeZone, opts.now()).date;
    res.json({
      clinic: { name: clinic.name, timeZone: clinic.timeZone, now: toStamp(localNow(clinic.timeZone, opts.now())) },
      services: clinic.services.map(({ id, name }) => ({ id, name })),
      bookings: store.listBookings(`${today}T00:00`),
      handoffs: store.listHandoffs().slice(0, 50),
      contacts: store.listContacts(50),
    });
  });

  router.get("/api/contacts/:waId/messages", (req, res) => {
    const waId = waIdParam.safeParse(req.params.waId);
    if (!waId.success) return void res.status(400).json({ error: "Invalid number" });
    const contact = store.getContact(waId.data);
    if (!contact) return void res.status(404).json({ error: "Unknown contact" });
    res.json({ contact, messages: store.recentMessages(waId.data, 0, 200) });
  });

  router.post("/api/contacts/:waId/messages", express.json({ limit: "16kb" }), async (req, res) => {
    const waId = waIdParam.safeParse(req.params.waId);
    const body = replySchema.safeParse(req.body);
    if (!waId.success || !body.success) return void res.status(400).json({ error: "Expected {\"text\": \"...\"}" });
    if (!store.getContact(waId.data)) return void res.status(404).json({ error: "Unknown contact" });

    const result = await messenger.send(waId.data, body.data.text);
    if (result === "text") store.addMessage(waId.data, "staff", body.data.text, opts.now().getTime());
    logger.info("staff reply", { to: maskPhone(waId.data), result });
    const notes: Record<string, string> = {
      text: "Sent.",
      template: "The 24-hour window is closed, so the approved template was sent instead of your text.",
      skipped_opted_out: "Not sent: this number has opted out (STOP).",
      skipped_unknown_contact: "Not sent: unknown contact.",
    };
    res.status(result === "text" ? 201 : result === "template" ? 200 : 409).json({ result, note: notes[result] });
  });

  router.post("/api/handoffs/:id/resolve", (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return void res.status(400).json({ error: "Invalid id" });
    const handoff = store.resolveHandoff(id.data, opts.now().getTime());
    if (!handoff) return void res.status(404).json({ error: "Unknown handoff" });
    logger.info("handoff resolved", { handoffId: handoff.id });
    res.json({ handoff });
  });

  return router;
}
