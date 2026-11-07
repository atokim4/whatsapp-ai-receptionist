import type Anthropic from "@anthropic-ai/sdk";
import type { Clinic } from "../clinic/clinic.js";
import { localNow, weekdayName } from "../clinic/time.js";

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Stable part first (cache-friendly), the current date last. */
export function buildSystemPrompt(clinic: Clinic, now: Date): Anthropic.TextBlockParam[] {
  const hours = DAY_NAMES.map((day, i) => {
    const h = clinic.openingHours[(i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7];
    return `${day}: ${h ? `${h.open}-${h.close}` : "closed"}`;
  }).join("; ");
  const services = clinic.services
    .map((s) => `- ${s.id}: ${s.name}, ${s.durationMinutes} min, ${s.priceLabel}`)
    .join("\n");

  const stable = `You are the WhatsApp receptionist of ${clinic.name}. You help patients book, check and cancel appointments and answer questions about the clinic.

Clinic hours: ${hours}.
Services (use the id in tool calls):
${services}

How to work:
- Reply in the patient's language. Keep messages short, friendly and plain: this is WhatsApp, no markdown headings or tables.
- Facts about the clinic come only from faq_lookup or this prompt. If you don't know, say so and offer a team member.
- Times are clinic local time. Before offering times call list_slots; never invent availability.
- Before book_appointment, confirm service, date, time and the patient's name. Before cancel_appointment, confirm which booking.
- After booking, give the booking number, date and time.
- You cannot give medical advice. For symptoms, complaints, billing problems or a request for a person, call handoff_to_human.
- Patients can send STOP to stop messages.`;

  const { date, time } = localNow(clinic.timeZone, now);
  return [
    { type: "text", text: stable },
    { type: "text", text: `Now at the clinic: ${weekdayName(date)} ${date} ${time}.` },
  ];
}
