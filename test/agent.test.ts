import { beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_REPLY, runAgent, type AgentInput } from "../src/agent/agent.js";
import { buildSystemPrompt } from "../src/agent/prompt.js";
import { toolDefinitions } from "../src/agent/tools.js";
import { BookingService } from "../src/clinic/booking.js";
import { sampleClinic } from "../src/clinic/sample-clinic.js";
import { silentLogger } from "../src/logger.js";
import { Store } from "../src/store.js";
import { callTool, Clock, lastToolResults, resultJson, say, ScriptedLlm, TIME_ZONE } from "./helpers.js";

const WA_ID = "15550000001";

describe("runAgent", () => {
  let llm: ScriptedLlm;
  let bookings: BookingService;
  let input: AgentInput;
  const run = (maxSteps?: number) =>
    runAgent({ llm, model: "claude-haiku-5-5", effort: "low", logger: silentLogger, maxSteps }, input);

  beforeEach(() => {
    const clock = new Clock();
    const store = new Store(":memory:");
    const clinic = sampleClinic(TIME_ZONE);
    store.upsertContactOnInbound(WA_ID, null, 0);
    bookings = new BookingService(clinic, store, clock.now);
    llm = new ScriptedLlm();
    input = {
      system: buildSystemPrompt(clinic, clock.now()),
      history: [{ role: "user", content: "Can I get a check-up Monday 9:00? I'm Alice Example" }],
      context: { waId: WA_ID, clinic, bookings },
    };
  });

  it("runs tools in a loop and returns the final answer", async () => {
    llm.then(
      callTool("list_slots", { date: "2026-11-09", service_id: "checkup" }),
      callTool("book_appointment", { service_id: "checkup", start: "2026-11-09T09:00", patient_name: "Alice Example" }),
      say("Booked! #1, Monday 9 Nov at 09:00."),
    );

    const turn = await run();

    expect(turn).toEqual({ reply: "Booked! #1, Monday 9 Nov at 09:00.", handoffReason: null });
    expect(bookings.upcomingFor(WA_ID)).toHaveLength(1);
    expect(llm.requests).toHaveLength(3);
    const first = llm.requests[0]!;
    expect(first.model).toBe("claude-haiku-5-5");
    expect(first.output_config).toEqual({ effort: "low" });
    expect(first.tools).toBe(toolDefinitions);
    // The tool result of step 2 is the booking, fed back to the model.
    const [result] = lastToolResults(llm);
    expect(result?.is_error).toBe(false);
    expect(resultJson(result)).toMatchObject({ booked: { booking_id: 1, start: "2026-11-09T09:00" } });
  });

  it("returns tool errors to the model instead of failing", async () => {
    llm.then(callTool("list_slots", { date: "2026-11-15", service_id: "checkup" }), say("We're closed on Sundays."));
    await run();
    const [result] = lastToolResults(llm);
    expect(result?.is_error).toBe(true);
    expect(resultJson(result)).toMatchObject({ error: expect.stringContaining("closed") as unknown });
  });

  it("rejects tool input that does not match the schema", async () => {
    llm.then(callTool("cancel_appointment", { booking_id: "one" }), callTool("nope", {}), say("ok"));
    await run();
    expect(resultJson(lastToolResults(llm)[0])).toMatchObject({ error: 'Unknown tool "nope"' });
    const firstResults = llm.requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(firstResults.content)).toContain("Invalid input");
  });

  it("reports a handoff requested by the model", async () => {
    llm.then(callTool("handoff_to_human", { reason: "Patient asks about a bill" }), say("A colleague will reply here."));
    expect(await run()).toEqual({ reply: "A colleague will reply here.", handoffReason: "Patient asks about a bill" });
  });

  it("escalates when the model API fails", async () => {
    const turn = await run(); // nothing scripted -> the client rejects
    expect(turn.reply).toBe(FALLBACK_REPLY);
    expect(turn.handoffReason).toMatch(/could not reach/);
  });

  it("escalates on a refusal or an empty reply", async () => {
    llm.then({ stop_reason: "refusal", content: [] });
    expect((await run()).handoffReason).toMatch(/declined/);
    llm.then({ stop_reason: "end_turn", content: [] });
    expect((await run()).handoffReason).toMatch(/empty/);
  });

  it("stops at the step limit", async () => {
    llm.then(...Array.from({ length: 5 }, () => callTool("list_my_bookings", {})));
    const turn = await run(3);
    expect(turn.reply).toBe(FALLBACK_REPLY);
    expect(llm.requests).toHaveLength(3);
  });
});

describe("tool definitions", () => {
  it("exposes strict JSON schemas the API accepts", () => {
    expect(toolDefinitions.map((t) => t.name)).toEqual([
      "faq_lookup",
      "list_slots",
      "book_appointment",
      "list_my_bookings",
      "cancel_appointment",
      "handoff_to_human",
    ]);
    for (const tool of toolDefinitions) {
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema).toMatchObject({ additionalProperties: false });
      const json = JSON.stringify(tool.input_schema);
      expect(json).not.toMatch(/"\$schema"|minLength|maxLength|minimum|maximum/);
    }
    expect(toolDefinitions[2]?.input_schema.required).toEqual(["service_id", "start", "patient_name"]);
  });
});
