import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminRouter } from "../src/admin/routes.js";
import { Store } from "../src/store.js";
import { silentLogger } from "../src/logger.js";
import { callTool, createHarness, listen, postSigned, say, textPayload } from "./helpers.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const ANNA = "15550000011";
const AUTH = `Basic ${Buffer.from("admin:correct-horse").toString("base64")}`;

describe("admin", () => {
  let h: ReturnType<typeof createHarness>;
  let server: Awaited<ReturnType<typeof listen>>;

  const api = (path: string, init: RequestInit = {}, auth = AUTH) =>
    fetch(`${server.url}/admin${path}`, { ...init, headers: { Authorization: auth, ...init.headers } });
  const reply = (waId: string, body: unknown) =>
    api(`/api/contacts/${waId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const patientSays = async (text: string) => {
    await postSigned(server.url, textPayload(ANNA, text));
    await h.receptionist.idle();
  };

  beforeEach(async () => {
    h = createHarness({
      mount: (app, { store, clinic, messenger, clock }) =>
        app.use("/admin", adminRouter({ store, clinic, messenger, user: "admin", password: "correct-horse", publicDir, logger: silentLogger, now: clock.now })),
    });
    server = await listen(h.app);
  });
  afterEach(async () => {
    await server.close();
    h.store.close();
  });

  it("requires the right basic-auth credentials", async () => {
    const none = await fetch(`${server.url}/admin/api/overview`);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    expect((await api("/api/overview", {}, `Basic ${Buffer.from("admin:wrong").toString("base64")}`)).status).toBe(401);
    expect((await api("/api/overview")).status).toBe(200);
    expect((await api("/")).headers.get("content-type")).toMatch(/text\/html/);
  });

  it("lists bookings, handoffs and conversations", async () => {
    h.llm.then(
      callTool("book_appointment", { service_id: "checkup", start: "2026-11-09T10:00", patient_name: "Anna Sample" }),
      say("Booked #1."),
      callTool("handoff_to_human", { reason: "Asked about a bill" }),
      say("A colleague will reply."),
    );
    await patientSays("Book me at 10");
    await patientSays("My bill is wrong");

    const overview = (await (await api("/api/overview")).json()) as Record<string, unknown>;
    expect(overview.bookings).toMatchObject([{ id: 1, patientName: "Anna Sample", status: "booked" }]);
    expect(overview.handoffs).toMatchObject([{ id: 1, waId: ANNA, reason: "Asked about a bill", status: "open" }]);
    expect(overview.contacts).toMatchObject([{ waId: ANNA, mode: "human", openHandoffId: 1 }]);

    const thread = (await (await api(`/api/contacts/${ANNA}/messages`)).json()) as { messages: { role: string }[] };
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("sends a staff reply over WhatsApp, then resolves the handoff back to the bot", async () => {
    h.llm.then(callTool("handoff_to_human", { reason: "Wants a person" }), say("A colleague will reply."));
    await patientSays("Can I talk to someone?");

    const res = await reply(ANNA, { text: "Hi, this is reception. How can I help?" });
    expect(res.status).toBe(201);
    expect(h.sender.sent.at(-1)).toEqual({ to: ANNA, kind: "text", body: "Hi, this is reception. How can I help?" });
    expect(h.store.recentMessages(ANNA, 0, 10).at(-1)).toMatchObject({ role: "staff" });

    const resolved = await api("/api/handoffs/1/resolve", { method: "POST" });
    expect(await resolved.json()).toMatchObject({ handoff: { status: "resolved" } });
    expect(h.store.getContact(ANNA)?.mode).toBe("bot");
    expect((await api("/api/handoffs/99/resolve", { method: "POST" })).status).toBe(404);
  });

  it("follows the WhatsApp rules for staff replies too", async () => {
    h.llm.then(say("Hello"));
    await patientSays("Hi");

    h.clock.advance(25 * 60 * 60 * 1000);
    const late = await reply(ANNA, { text: "Following up" });
    expect(await late.json()).toMatchObject({ result: "template" });
    expect(h.sender.sent.at(-1)).toMatchObject({ kind: "template" });

    h.store.setOptedOut(ANNA, true);
    expect((await reply(ANNA, { text: "Hello?" })).status).toBe(409);
  });

  it("rejects bad input", async () => {
    expect((await reply("15550009999", { text: "Hi" })).status).toBe(404);
    expect((await reply("not-a-number", { text: "Hi" })).status).toBe(400);
    expect((await reply(ANNA, { text: "" })).status).toBe(400);
    const form = await api(`/api/contacts/${ANNA}/messages`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=hi" });
    expect(form.status).toBe(400);
  });
});

describe("Store.listContacts", () => {
  it("orders conversations by last activity and shows the open handoff", () => {
    const store = new Store(":memory:");
    store.upsertContactOnInbound("111111", null, 1);
    store.addMessage("111111", "user", "a", 10);
    store.upsertContactOnInbound("222222", null, 2);
    store.addMessage("222222", "user", "b", 5);
    store.upsertContactOnInbound("333333", null, 20);
    store.openHandoff("222222", "Needs a person", 6);
    expect(store.listContacts().map((c) => [c.waId, c.openHandoffId])).toEqual([
      ["333333", null],
      ["111111", null],
      ["222222", 1],
    ]);
    store.close();
  });
});
