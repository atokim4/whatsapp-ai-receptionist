import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DemoLlm } from "../src/demo/demo-llm.js";
import { createHarness, listen, postSigned, textPayload } from "./helpers.js";

const ANNA = "15550000011";
const BEN = "15550000022";

/** The offline demo model driving the real agent loop, tools, booking rules and database. Clock: Monday 08:00. */
describe("DemoLlm through the receptionist", () => {
  let h: ReturnType<typeof createHarness>;
  let server: Awaited<ReturnType<typeof listen>>;

  const send = async (text: string, from = ANNA): Promise<string | undefined> => {
    const before = h.sender.sent.length;
    expect((await postSigned(server.url, textPayload(from, text))).status).toBe(200);
    await h.receptionist.idle();
    const reply = h.sender.sent.slice(before).at(-1);
    return reply?.kind === "text" ? reply.body : reply ? `[template ${reply.name}]` : undefined;
  };

  beforeEach(async () => {
    h = createHarness({ rateLimit: 50, llm: (clinic) => new DemoLlm(clinic) });
    server = await listen(h.app);
  });
  afterEach(async () => {
    await server.close();
    h.store.close();
  });

  it("greets and answers FAQ questions only from the FAQ", async () => {
    expect(await send("Hi")).toMatch(/assistant of Maple Dental/);
    expect(await send("What are your opening hours?")).toBe("Mon–Thu 09:00–18:00, Fri 09:00–16:00, Sat 10:00–14:00. Closed on Sundays.");
    expect(await send("Is there parking?")).toMatch(/free street parking/);
    expect(await send("Do you sell toothbrushes?")).toMatch(/I don't have an answer/);
  });

  it("collects booking details over several messages and books a real slot", async () => {
    expect(await send("Book a check-up on Wednesday")).toMatch(/^Free times for check-up and cleaning on Wednesday 2026-11-11: 09:00, 09:30/);
    expect(await send("10:00 for Anna Sample")).toBe(
      'Booked! #1: check-up and cleaning on Wednesday 2026-11-11 at 10:00 for Anna Sample.\nTo cancel, send "cancel #1".',
    );
    expect(h.store.getBooking(1)).toMatchObject({ waId: ANNA, start: "2026-11-11T10:00", end: "2026-11-11T10:30", status: "booked" });

    // The booking is finished: a stray time does not book again.
    await send("11:00 for Anna Sample");
    expect(h.store.getBooking(2)).toBeNull();
  });

  it("asks for a name when it is missing", async () => {
    expect(await send("I'd like an appointment for a consultation tomorrow at 11:00")).toBe("What name should I put the booking under?");
    expect(await send("Ben Example")).toMatch(/^Booked! #1: consultation on Tuesday 2026-11-10 at 11:00 for Ben Example/);
  });

  it("passes on booking-rule errors and asks for another day", async () => {
    expect(await send("Book a filling on Sunday")).toBe("Sorry, the clinic is closed on that day. Which other day would suit you?");
    await send("Book a check-up on Wednesday at 10:00 for Anna Sample");
    expect(await send("Book a check-up on Wednesday at 10:00 for Ben Example", BEN)).toMatch(/^Sorry, that time is not available/);
  });

  it("lists and cancels only the sender's own bookings", async () => {
    await send("Book a check-up on Wednesday at 10:00 for Anna Sample");
    expect(await send("Cancel my booking")).toBe(
      'Your upcoming bookings:\n#1 check-up and cleaning, 2026-11-11 at 10:00\nWhich one should I cancel? Send "cancel #1".',
    );
    expect(await send("cancel #1", BEN)).toBe("Sorry, no booking #1 found for this number.");
    expect(await send("cancel #1")).toBe("Booking #1 on 2026-11-11 at 10:00 is cancelled. Anything else?");
    expect(h.store.getBooking(1)?.status).toBe("cancelled");
    expect(await send("my bookings")).toBe("You have no upcoming bookings with us.");
  });

  it("hands off to a human and then stays quiet", async () => {
    expect(await send("I want to talk to a person")).toMatch(/passed your message to our team/);
    expect(h.store.listHandoffs()).toMatchObject([{ waId: ANNA, status: "open", reason: 'Patient wrote: "I want to talk to a person"' }]);
    expect(await send("Hello?")).toBeUndefined();
  });
});
