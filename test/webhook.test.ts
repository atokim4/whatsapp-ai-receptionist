import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_REPLY } from "../src/agent/agent.js";
import { TEXTS } from "../src/receptionist.js";
import {
  callTool,
  createHarness,
  listen,
  PHONE_NUMBER_ID,
  postSigned,
  say,
  textPayload,
  VERIFY_TOKEN,
} from "./helpers.js";

const ALICE = "15550000001";

describe("webhook", () => {
  let h: ReturnType<typeof createHarness>;
  let server: Awaited<ReturnType<typeof listen>>;

  const send = async (text: string, id?: string) => {
    const res = await postSigned(server.url, textPayload(ALICE, text, id));
    expect(res.status).toBe(200);
    await h.receptionist.idle();
  };
  const textsSent = () => h.sender.sent.map((s) => (s.kind === "text" ? s.body : `[template ${s.name}]`));

  beforeEach(async () => {
    h = createHarness({ rateLimit: 3 });
    server = await listen(h.app);
  });
  afterEach(async () => {
    await server.close();
    h.store.close();
  });

  describe("GET verification", () => {
    const verify = (token: string, mode = "subscribe") =>
      fetch(`${server.url}/webhook?hub.mode=${mode}&hub.verify_token=${token}&hub.challenge=1158201444`);

    it("echoes the challenge for the right token", async () => {
      const res = await verify(VERIFY_TOKEN);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("1158201444");
    });

    it("refuses a wrong token or mode", async () => {
      expect((await verify("wrong")).status).toBe(403);
      expect((await verify(VERIFY_TOKEN, "unsubscribe")).status).toBe(403);
    });
  });

  describe("POST security", () => {
    it("rejects unsigned and wrongly signed requests without processing them", async () => {
      h.llm.then(say("should not be used"));
      const unsigned = await fetch(`${server.url}/webhook`, { method: "POST", body: JSON.stringify(textPayload(ALICE, "hi")) });
      expect(unsigned.status).toBe(401);
      expect((await postSigned(server.url, textPayload(ALICE, "hi"), "not-the-secret")).status).toBe(401);
      await h.receptionist.idle();
      expect(h.llm.requests).toHaveLength(0);
    });

    it("answers 400 to signed invalid JSON and 200 to signed payloads it does not handle", async () => {
      const { signBody } = await import("../src/whatsapp/signature.js");
      const bad = await fetch(`${server.url}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": signBody("{nope", "test-app-secret") },
        body: "{nope",
      });
      expect(bad.status).toBe(400);
      expect((await postSigned(server.url, { object: "page", entry: [] })).status).toBe(200);
    });

    it("ignores messages addressed to another phone number id", async () => {
      await postSigned(server.url, textPayload(ALICE, "hi", undefined, "999"));
      await h.receptionist.idle();
      expect(h.sender.sent).toHaveLength(0);
      expect(PHONE_NUMBER_ID).not.toBe("999");
    });
  });

  it("answers a message through the agent and keeps session memory", async () => {
    h.llm.then(say("Hello! How can I help?"), say("We open at 09:00."));
    await send("Hi");
    await send("When do you open?");

    expect(textsSent()).toEqual(["Hello! How can I help?", "We open at 09:00."]);
    expect(h.llm.requests[1]?.messages).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "When do you open?" },
    ]);
  });

  it("processes a redelivered message only once", async () => {
    h.llm.then(say("Hi there"));
    await send("Hi", "wamid.SAME");
    await send("Hi", "wamid.SAME");
    expect(h.llm.requests).toHaveLength(1);
    expect(h.sender.sent).toHaveLength(1);
  });

  it("books, then cancels, through tool calls", async () => {
    h.llm.then(
      callTool("book_appointment", { service_id: "checkup", start: "2026-11-09T10:00", patient_name: "Alice Example" }),
      say("Done, booking #1 at 10:00."),
      callTool("list_my_bookings", {}),
      callTool("cancel_appointment", { booking_id: 1 }),
      say("Booking #1 is cancelled."),
    );
    await send("Book a check-up today at 10:00 for Alice Example");
    expect(h.bookings.upcomingFor(ALICE)).toHaveLength(1);
    await send("Please cancel it");
    expect(h.bookings.upcomingFor(ALICE)).toHaveLength(0);
    expect(textsSent()).toEqual(["Done, booking #1 at 10:00.", "Booking #1 is cancelled."]);
  });

  it("hands off to a human and then stays quiet", async () => {
    h.llm.then(callTool("handoff_to_human", { reason: "Wants to talk about a bill" }), say("A team member will reply here."));
    await send("I want to talk to a person about my bill");
    await send("Hello?");

    expect(h.llm.requests).toHaveLength(2); // only the first message reached the model
    expect(textsSent()).toEqual(["A team member will reply here."]);
    expect(h.store.getContact(ALICE)?.mode).toBe("human");
    expect(h.store.listHandoffs()).toMatchObject([{ waId: ALICE, reason: "Wants to talk about a bill", status: "open" }]);

    h.store.resolveHandoff(1, Date.now());
    h.llm.then(say("Back to the assistant."));
    await send("Thanks");
    expect(textsSent().at(-1)).toBe("Back to the assistant.");
  });

  it("escalates when the model is unavailable", async () => {
    await send("Hi"); // nothing scripted -> LLM error
    expect(textsSent()).toEqual([FALLBACK_REPLY]);
    expect(h.store.listHandoffs()).toHaveLength(1);
  });

  it("honours STOP and START", async () => {
    await send("stop");
    await send("When do you open?");
    expect(h.llm.requests).toHaveLength(0);
    expect(textsSent()).toEqual([TEXTS.optedOut]);

    h.llm.then(say("We open at 09:00."));
    await send("START");
    await send("When do you open?");
    expect(textsSent()).toEqual([TEXTS.optedOut, TEXTS.optedIn, "We open at 09:00."]);
  });

  it("rate limits a flood, warning once", async () => {
    h.llm.then(say("1"), say("2"), say("3"));
    for (let i = 0; i < 6; i++) await send(`message ${i}`);
    expect(textsSent()).toEqual(["1", "2", "3", TEXTS.rateLimited]);
    h.clock.advance(61_000);
    h.llm.then(say("4"));
    await send("again");
    expect(textsSent().at(-1)).toBe("4");
  });

  it("replies to media with a text-only notice", async () => {
    const payload = textPayload(ALICE, "x");
    const message = payload.entry[0]!.changes[0]!.value.messages[0]! as Record<string, unknown>;
    message.type = "image";
    delete message.text;
    message.image = { id: "MEDIA_ID", mime_type: "image/jpeg" };
    await postSigned(server.url, payload);
    await h.receptionist.idle();
    expect(textsSent()).toEqual([TEXTS.unsupported]);
  });

  it("acknowledges delivery status callbacks without replying", async () => {
    const payload = textPayload(ALICE, "x");
    const value = payload.entry[0]!.changes[0]!.value as Record<string, unknown>;
    delete value.messages;
    value.statuses = [{ id: "wamid.OUT1", status: "delivered", recipient_id: ALICE }];
    expect((await postSigned(server.url, payload)).status).toBe(200);
    await h.receptionist.idle();
    expect(h.sender.sent).toHaveLength(0);
  });
});
