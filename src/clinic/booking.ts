import type { Booking, Store } from "../store.js";
import type { Clinic, FaqEntry, Service } from "./clinic.js";
import { addDays, addMinutes, isValidDate, isValidStamp, isoWeekday, localNow, toStamp } from "./time.js";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: string): Result<T> => ({ ok: false, error });

/** Scheduling rules for one clinic with a single chair: no two bookings may overlap. */
export class BookingService {
  constructor(
    private readonly clinic: Clinic,
    private readonly store: Store,
    private readonly now: () => Date,
  ) {}

  findService(serviceId: string): Service | undefined {
    return this.clinic.services.find((s) => s.id === serviceId);
  }

  today(): string {
    return localNow(this.clinic.timeZone, this.now()).date;
  }

  private earliestStart(): string {
    return addMinutes(toStamp(localNow(this.clinic.timeZone, this.now())), this.clinic.minNoticeMinutes);
  }

  private checkDate(date: string): string | null {
    if (!isValidDate(date)) return "Date must be a real calendar date in YYYY-MM-DD format.";
    const today = this.today();
    if (date < today) return "That date is in the past.";
    if (date > addDays(today, this.clinic.maxDaysAhead)) {
      return `Bookings open at most ${this.clinic.maxDaysAhead} days ahead.`;
    }
    if (!this.clinic.openingHours[isoWeekday(date)]) return "The clinic is closed on that day.";
    return null;
  }

  /** Free start times ("HH:mm") for a service on a date. */
  listSlots(date: string, serviceId: string): Result<string[]> {
    const service = this.findService(serviceId);
    if (!service) return fail(`Unknown service "${serviceId}".`);
    const dateError = this.checkDate(date);
    if (dateError) return fail(dateError);

    const hours = this.clinic.openingHours[isoWeekday(date)]!;
    const closing = `${date}T${hours.close}`;
    const earliest = this.earliestStart();
    const taken = this.store.bookingsOnDay(date);

    const slots: string[] = [];
    for (let start = `${date}T${hours.open}`; addMinutes(start, service.durationMinutes) <= closing; start = addMinutes(start, this.clinic.slotMinutes)) {
      const end = addMinutes(start, service.durationMinutes);
      if (start < earliest) continue;
      if (taken.some((b) => b.start < end && b.end > start)) continue;
      slots.push(start.slice(11));
    }
    return ok(slots);
  }

  book(waId: string, serviceId: string, start: string, patientName: string): Result<Booking> {
    const service = this.findService(serviceId);
    if (!service) return fail(`Unknown service "${serviceId}".`);
    const name = patientName.trim();
    if (name.length < 2 || name.length > 80) return fail("Please provide the patient's name (2-80 characters).");
    if (!isValidStamp(start)) return fail("Start must be in YYYY-MM-DDTHH:mm format.");

    const date = start.slice(0, 10);
    const dateError = this.checkDate(date);
    if (dateError) return fail(dateError);

    const slots = this.listSlots(date, serviceId);
    if (!slots.ok) return slots;
    if (!slots.value.includes(start.slice(11))) {
      return fail(
        slots.value.length > 0
          ? `That time is not available. Free times that day: ${slots.value.join(", ")}.`
          : "There are no free times left that day.",
      );
    }

    const active = this.upcomingFor(waId);
    if (active.length >= this.clinic.maxActiveBookingsPerPatient) {
      return fail(
        `This number already has ${active.length} upcoming bookings (limit ${this.clinic.maxActiveBookingsPerPatient}). Cancel one first.`,
      );
    }

    return ok(
      this.store.insertBooking({
        waId,
        patientName: name,
        serviceId,
        start,
        end: addMinutes(start, service.durationMinutes),
        createdAt: this.now().getTime(),
      }),
    );
  }

  upcomingFor(waId: string): Booking[] {
    return this.store.upcomingBookingsFor(waId, toStamp(localNow(this.clinic.timeZone, this.now())));
  }

  /** Cancels a booking that belongs to this WhatsApp user. Other users' bookings look like "not found". */
  cancel(waId: string, bookingId: number): Result<Booking> {
    const booking = this.store.getBooking(bookingId);
    if (!booking || booking.waId !== waId) return fail(`No booking #${bookingId} found for this number.`);
    if (booking.status === "cancelled") return fail(`Booking #${bookingId} is already cancelled.`);
    if (booking.start < toStamp(localNow(this.clinic.timeZone, this.now()))) {
      return fail(`Booking #${bookingId} is in the past and cannot be cancelled.`);
    }
    this.store.cancelBooking(bookingId, this.now().getTime());
    return ok({ ...booking, status: "cancelled" });
  }
}

const WORD = /[\p{L}\p{N}]+/gu;

/** Keyword search over the clinic FAQ. Small and predictable on purpose: answers come only from this list. */
export function searchFaq(faq: FaqEntry[], question: string, limit = 2): FaqEntry[] {
  const words = new Set((question.toLowerCase().match(WORD) ?? []).map(stem));
  return faq
    .map((entry) => ({ entry, score: entry.keywords.filter((k) => words.has(stem(k))).length }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry);
}

function stem(word: string): string {
  return word.length > 4 ? word.replace(/(ing|es|s)$/, "") : word;
}
