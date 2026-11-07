import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "../agent/llm.js";
import type { Clinic } from "../clinic/clinic.js";
import { addDays, isValidDate, isoWeekday, weekdayName } from "../clinic/time.js";

/**
 * Offline stand-in for Claude, used only in demo mode when no ANTHROPIC_API_KEY is set.
 *
 * It is a small rule-based intent matcher, not a language model. It speaks the same protocol as the
 * Messages API (tool_use blocks, then text after the tool results), so the demo runs through the real agent
 * loop, the real tools, the booking rules and the database. It only understands simple English phrasing.
 */
export class DemoLlm implements LlmClient {
  private callSeq = 0;

  constructor(private readonly clinic: Clinic) {}

  create(request: LlmRequest): Promise<LlmResponse> {
    const last = request.messages.at(-1);
    if (!last || last.role !== "user") return Promise.resolve(say("Hello! How can I help?"));
    const results = typeof last.content === "string" ? [] : last.content.filter((b) => b.type === "tool_result");
    const response =
      results.length > 0 ? this.afterTool(request.messages, results[0]!) : this.onUserText(request, latestLine(last.content));
    return Promise.resolve(response);
  }

  private onUserText(request: LlmRequest, text: string): LlmResponse {
    const lower = text.toLowerCase();
    const today = clinicToday(request.system);

    if (HANDOFF.test(lower)) {
      return this.callTool("handoff_to_human", { reason: `Patient wrote: "${truncate(text, 200)}"` });
    }
    if (/\bcancel\b/.test(lower)) {
      const id = bookingId(text);
      return id === null ? this.callTool("list_my_bookings", {}) : this.callTool("cancel_appointment", { booking_id: id });
    }
    if (/\bmy (bookings?|appointments?|visits?)\b|\bwhen is my\b/.test(lower)) return this.callTool("list_my_bookings", {});
    if (FAQ_FIRST.test(lower)) return this.callTool("faq_lookup", { question: text });

    const booking = this.bookingDraft(request.messages, today);
    if (booking) {
      if (!booking.serviceId) {
        const list = this.clinic.services.map((s) => `${s.name} (${s.durationMinutes} min, ${s.priceLabel})`).join("; ");
        return say(`Happy to book you in. Which service? ${list}.`);
      }
      if (!booking.date) return say(`Which day works for you? For example "Monday" or a date like ${addDays(today ?? "2026-01-01", 7)}.`);
      if (!booking.time) return this.callTool("list_slots", { date: booking.date, service_id: booking.serviceId });
      if (!booking.name) return say(NAME_QUESTION);
      return this.callTool("book_appointment", {
        service_id: booking.serviceId,
        start: `${booking.date}T${booking.time}`,
        patient_name: booking.name,
      });
    }

    if (GREETING.test(lower)) {
      return say(
        `Hi! This is the assistant of ${this.clinic.name}. I can book or cancel a visit, show your bookings, ` +
          `answer questions about hours, address, parking or payment, or pass you to a person.`,
      );
    }
    return this.callTool("faq_lookup", { question: text });
  }

  private afterTool(messages: Anthropic.MessageParam[], result: Anthropic.ToolResultBlockParam): LlmResponse {
    const call = findToolUse(messages, result.tool_use_id);
    const data = parseResult(result);
    if (typeof data.error === "string") {
      const followUp = call?.name === "list_slots" ? " Which other day would suit you?" : "";
      return say(`Sorry, ${lowerFirst(data.error)}${followUp}`);
    }

    switch (call?.name) {
      case "faq_lookup": {
        const matches = Array.isArray(data.matches) ? (data.matches as { answer: string }[]) : [];
        return say(
          matches.length > 0
            ? matches.map((m) => m.answer).join("\n")
            : `I don't have an answer to that. Write "talk to a person" and someone from the team will reply here.`,
        );
      }
      case "list_slots": {
        const times = (data.free_times as string[] | undefined) ?? [];
        const service = this.serviceName(String(data.service_id));
        const day = `${String(data.weekday)} ${String(data.date)}`;
        if (times.length === 0) return say(`There are no free times for ${service} on ${day}. Would another day work?`);
        const shown = times.slice(0, 8).join(", ") + (times.length > 8 ? " and later" : "");
        return say(`Free times for ${service} on ${day}: ${shown}.\nReply with a time and your name, for example "${times[0]} for Anna".`);
      }
      case "book_appointment": {
        const b = data.booked as { booking_id: number; service_id: string; start: string; patient_name: string };
        const [date = "", time = ""] = b.start.split("T");
        return say(
          `Booked! #${b.booking_id}: ${this.serviceName(b.service_id)} on ${weekdayName(date)} ${date} at ${time} for ${b.patient_name}.\n` +
            `To cancel, send "cancel #${b.booking_id}".`,
        );
      }
      case "list_my_bookings": {
        const list = (data.bookings as { booking_id: number; service_id: string; start: string }[] | undefined) ?? [];
        if (list.length === 0) return say("You have no upcoming bookings with us.");
        const lines = list.map((b) => `#${b.booking_id} ${this.serviceName(b.service_id)}, ${b.start.replace("T", " at ")}`);
        const asked = latestUserText(messages).toLowerCase();
        const hint = /\bcancel\b/.test(asked) ? `\nWhich one should I cancel? Send "cancel #${list[0]!.booking_id}".` : "";
        return say(`Your upcoming bookings:\n${lines.join("\n")}${hint}`);
      }
      case "cancel_appointment": {
        const c = data.cancelled as { booking_id: number; start: string };
        return say(`Booking #${c.booking_id} on ${c.start.replace("T", " at ")} is cancelled. Anything else?`);
      }
      case "handoff_to_human":
        return say("I've passed your message to our team. A staff member will reply in this chat during opening hours.");
      default:
        return say("Sorry, something went wrong on my side.");
    }
  }

  /**
   * Collects booking details over the last few user messages, so "book a check-up on Monday" followed by
   * "10:00 for Anna" works. Starts at the most recent message that asked to book.
   */
  private bookingDraft(messages: Anthropic.MessageParam[], today: string | null): BookingDraft | null {
    const turns = conversationTurns(messages).slice(-7);
    const startIndex = turns.findLastIndex((t) => t.role === "user" && BOOKING.test(t.text.toLowerCase()));
    if (startIndex === -1) return null;

    const draft: BookingDraft = {};
    for (let i = startIndex; i < turns.length; i++) {
      const turn = turns[i]!;
      if (turn.role === "assistant") {
        if (turn.text.startsWith("Booked!")) return null; // that booking is finished
        continue;
      }
      const askedName = turns[i - 1]?.text === NAME_QUESTION;
      Object.assign(draft, this.entities(turn.text, today, askedName));
    }
    return draft;
  }

  private entities(text: string, today: string | null, wholeTextIsName: boolean): BookingDraft {
    const lower = text.toLowerCase();
    const found: BookingDraft = {};
    const service = Object.entries(SERVICE_WORDS).find(([, words]) => words.some((w) => lower.includes(w)));
    if (service && this.clinic.services.some((s) => s.id === service[0])) found.serviceId = service[0];
    const date = today ? parseDate(lower, today) : null;
    if (date) found.date = date;
    const time = parseTime(lower);
    if (time) found.time = time;
    const name = wholeTextIsName ? cleanName(text) : parseName(text);
    if (name) found.name = name;
    return found;
  }

  private serviceName(id: string): string {
    return this.clinic.services.find((s) => s.id === id)?.name.toLowerCase() ?? id;
  }

  private callTool(name: string, input: Record<string, unknown>): LlmResponse {
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: `toolu_demo_${++this.callSeq}`, name, input, caller: { type: "direct" } }],
    };
  }
}

interface BookingDraft {
  serviceId?: string;
  date?: string;
  time?: string;
  name?: string;
}

const NAME_QUESTION = "What name should I put the booking under?";
const HANDOFF =
  /\b(human|person|someone|staff|operator|manager|receptionist|complain\w*|refund|billing|invoice wrong|pain|hurts?|bleeding|swollen|swelling)\b/;
const BOOKING = /\b(book|booking|appointment|reserve|schedule|free times?|available|availability|slots?)\b/;
const FAQ_FIRST = /\b(hours|opening|open|close|closing|address|where|parking|park|pay|payment|insurance|policy)\b/;
const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening))\b/;
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const NOT_NAMES = new Set([...WEEKDAYS, "today", "tomorrow", "me", "my", "the", "a", "an"]);

const SERVICE_WORDS: Record<string, string[]> = {
  checkup: ["check-up", "checkup", "check up", "cleaning", "clean"],
  whitening: ["whiten"],
  filling: ["filling", "cavity"],
  consultation: ["consult"],
};

const say = (text: string): LlmResponse => ({ stop_reason: "end_turn", content: [{ type: "text", text, citations: null }] });

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Merged history turns join messages with newlines; the newest message is the last line. */
function latestLine(content: string | Anthropic.ContentBlockParam[]): string {
  const text = typeof content === "string" ? content : content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  return text.split("\n").at(-1)?.trim() ?? "";
}

function conversationTurns(messages: Anthropic.MessageParam[]): { role: "user" | "assistant"; text: string }[] {
  return messages.flatMap((m) => {
    if (typeof m.content === "string" && (m.role === "user" || m.role === "assistant")) {
      const role = m.role;
      return m.content.split("\n").map((line) => ({ role, text: line.trim() }));
    }
    return [];
  });
}

function latestUserText(messages: Anthropic.MessageParam[]): string {
  const m = messages.findLast((msg) => msg.role === "user" && typeof msg.content === "string");
  return m ? latestLine(m.content) : "";
}

function findToolUse(messages: Anthropic.MessageParam[], id: string): Anthropic.ToolUseBlockParam | undefined {
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const block = m.content.find((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use" && b.id === id);
    if (block) return block;
  }
  return undefined;
}

function parseResult(result: Anthropic.ToolResultBlockParam): Record<string, unknown> {
  if (typeof result.content !== "string") return {};
  try {
    const value: unknown = JSON.parse(result.content);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads "today" from the system prompt line the receptionist adds ("Now at the clinic: Monday 2026-11-09 08:00."). */
function clinicToday(system: LlmRequest["system"]): string | null {
  const text = typeof system === "string" ? system : (system ?? []).map((b) => b.text).join("\n");
  return /Now at the clinic: \w+ (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? null;
}

function parseDate(lower: string, today: string): string | null {
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lower)?.[1];
  if (iso && isValidDate(iso)) return iso;
  if (/\btoday\b/.test(lower)) return today;
  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);
  const day = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(lower));
  if (day === -1) return null;
  // The next such weekday after today: "Monday" said on a Monday means next week.
  const ahead = ((day + 1 - isoWeekday(today) + 7) % 7) || 7;
  return addDays(today, ahead);
}

function parseTime(lower: string): string | null {
  const clock = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(lower);
  if (clock) return `${clock[1]!.padStart(2, "0")}:${clock[2]}`;
  const ampm = /\b(1[0-2]|0?[1-9])\s?(am|pm)\b/.exec(lower);
  if (!ampm) return null;
  const hour = (Number(ampm[1]) % 12) + (ampm[2] === "pm" ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:00`;
}

const NAME_AFTER = /\b(?:for|name is|i am|i'm|name:)\s+(\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){0,3})/u;

function parseName(text: string): string | null {
  const match = NAME_AFTER.exec(text)?.[1];
  if (!match) return null;
  const words = match.split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
  return words.length > 0 ? words.join(" ") : null;
}

function cleanName(text: string): string | null {
  const name = text.replace(/^(it'?s|my name is|name is|i am|i'm)\s+/i, "").replace(/[.!]+$/, "").trim();
  return /^\p{L}[\p{L}' .-]{1,79}$/u.test(name) ? name : null;
}

function bookingId(text: string): number | null {
  const match = /#\s?(\d+)|\b(?:booking|appointment|number)\s+(\d+)\b|\bcancel\s+(\d+)\b/i.exec(text);
  const digits = match?.[1] ?? match?.[2] ?? match?.[3];
  return digits ? Number(digits) : null;
}
