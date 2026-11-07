import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { searchFaq, type BookingService } from "../clinic/booking.js";
import type { Clinic } from "../clinic/clinic.js";
import { weekdayName } from "../clinic/time.js";

/** What a tool may touch. The WhatsApp number comes from the webhook, never from the model. */
export interface ToolContext {
  waId: string;
  clinic: Clinic;
  bookings: BookingService;
  requestHandoff: (reason: string) => void;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

interface ToolDef<S extends z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => unknown;
}

interface Tool {
  name: string;
  description: string;
  schema: z.ZodObject;
  execute: (input: unknown, ctx: ToolContext) => ToolOutcome;
}

const errorOutcome = (error: unknown): ToolOutcome => ({ content: JSON.stringify(error), isError: true });

/** Wraps a tool so its input is validated against its own schema before `run` sees it. Never throws. */
function defineTool<S extends z.ZodObject>({ name, description, schema, run }: ToolDef<S>): Tool {
  return {
    name,
    description,
    schema,
    execute: (input, ctx) => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return errorOutcome({ error: "Invalid input", issues: parsed.error.issues.map((i) => i.message) });
      try {
        const output = run(parsed.data, ctx);
        const isError = typeof output === "object" && output !== null && "error" in output;
        return { content: JSON.stringify(output), isError };
      } catch (err) {
        return errorOutcome({ error: err instanceof Error ? err.message : "Tool failed" });
      }
    },
  };
}

const date = z.string().describe("Date in YYYY-MM-DD (clinic local time)");

const tools = [
  defineTool({
    name: "faq_lookup",
    description:
      "Search the clinic's FAQ (hours, address, parking, payment, insurance, cancellation policy, emergencies). " +
      "Use it before answering any question about the clinic; answer only from what it returns.",
    schema: z.strictObject({ question: z.string().min(1).describe("The patient's question in their words") }),
    run: ({ question }, { clinic }) => {
      const matches = searchFaq(clinic.faq, question);
      return matches.length > 0
        ? { matches: matches.map(({ question: q, answer }) => ({ question: q, answer })) }
        : { matches: [], note: "No FAQ entry matches. Do not guess; offer to connect the patient with the team." };
    },
  }),
  defineTool({
    name: "list_slots",
    description: "List free start times for a service on one date. Call it before offering or booking any time.",
    schema: z.strictObject({ date, service_id: z.string().describe("Service id from the system prompt") }),
    run: ({ date: day, service_id }, { bookings }) => {
      const result = bookings.listSlots(day, service_id);
      return result.ok ? { date: day, weekday: weekdayName(day), service_id, free_times: result.value } : { error: result.error };
    },
  }),
  defineTool({
    name: "book_appointment",
    description:
      "Book an appointment for the person in this chat. Only call it after the patient confirmed the service, date, time and name.",
    schema: z.strictObject({
      service_id: z.string(),
      start: z.string().describe("Start in YYYY-MM-DDTHH:mm (clinic local time), one of the free times from list_slots"),
      patient_name: z.string().describe("Full name of the patient"),
    }),
    run: ({ service_id, start, patient_name }, { waId, bookings }) => {
      const result = bookings.book(waId, service_id, start, patient_name);
      if (!result.ok) return { error: result.error };
      const b = result.value;
      return { booked: { booking_id: b.id, service_id: b.serviceId, start: b.start, end: b.end, patient_name: b.patientName } };
    },
  }),
  defineTool({
    name: "list_my_bookings",
    description: "List upcoming appointments booked from this WhatsApp number.",
    schema: z.strictObject({}),
    run: (_input, { waId, bookings }) => ({
      bookings: bookings.upcomingFor(waId).map((b) => ({ booking_id: b.id, service_id: b.serviceId, start: b.start, patient_name: b.patientName })),
    }),
  }),
  defineTool({
    name: "cancel_appointment",
    description: "Cancel one of this number's upcoming appointments. Confirm with the patient which booking first.",
    schema: z.strictObject({ booking_id: z.number().int().positive() }),
    run: ({ booking_id }, { waId, bookings }) => {
      const result = bookings.cancel(waId, booking_id);
      return result.ok ? { cancelled: { booking_id, start: result.value.start } } : { error: result.error };
    },
  }),
  defineTool({
    name: "handoff_to_human",
    description:
      "Pass the conversation to a staff member. Use it when the patient asks for a person, has a medical question, " +
      "a complaint, a billing problem, or anything the other tools cannot answer. After this the bot stops replying.",
    schema: z.strictObject({ reason: z.string().min(3).max(300).describe("Short summary for the staff member") }),
    run: ({ reason }, { requestHandoff }) => {
      requestHandoff(reason);
      return { handed_off: true, note: "Tell the patient a team member will reply in this chat during opening hours." };
    },
  }),
];

/** Keywords strict tool use does not accept. Zod still enforces them when the tool runs. */
const UNSUPPORTED_IN_STRICT = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);

function toStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictSchema);
  if (typeof node !== "object" || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => !UNSUPPORTED_IN_STRICT.has(key))
      .map(([key, value]) => [key, key === "properties" ? mapValues(value) : toStrictSchema(value)]),
  );
}

// Property names are user-chosen and must not be filtered like keywords.
function mapValues(properties: unknown): unknown {
  if (typeof properties !== "object" || properties === null) return properties;
  return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, toStrictSchema(schema)]));
}

export const toolDefinitions: Anthropic.Tool[] = tools.map((t) => {
  const schema = toStrictSchema(z.toJSONSchema(t.schema)) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.description,
    input_schema: { ...schema, type: "object" },
    strict: true,
  };
});

export function executeTool(name: string, input: unknown, ctx: ToolContext): ToolOutcome {
  const tool = tools.find((t) => t.name === name);
  return tool ? tool.execute(input, ctx) : errorOutcome({ error: `Unknown tool "${name}"` });
}
