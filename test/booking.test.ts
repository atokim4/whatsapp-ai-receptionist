import { beforeEach, describe, expect, it } from "vitest";
import { BookingService, searchFaq } from "../src/clinic/booking.js";
import { sampleClinic } from "../src/clinic/sample-clinic.js";
import { addDays, addMinutes, isValidDate, isValidStamp, isoWeekday, localNow } from "../src/clinic/time.js";
import { Store } from "../src/store.js";
import { Clock, TIME_ZONE } from "./helpers.js";

const ALICE = "15550000001";
const BOB = "15550000002";
const MONDAY = "2026-11-09";

describe("BookingService", () => {
  let clock: Clock;
  let store: Store;
  let svc: BookingService;

  beforeEach(() => {
    clock = new Clock();
    store = new Store(":memory:");
    svc = new BookingService(sampleClinic(TIME_ZONE), store, clock.now);
    store.upsertContactOnInbound(ALICE, null, 0);
    store.upsertContactOnInbound(BOB, null, 0);
  });

  it("lists half-hour slots inside opening hours", () => {
    const slots = svc.listSlots(MONDAY, "checkup");
    expect(slots).toEqual({ ok: true, value: expect.arrayContaining(["09:00", "09:30", "17:30"]) as unknown });
    if (slots.ok) expect(slots.value).toHaveLength(18);
  });

  it("does not offer a 60-minute service that would run past closing", () => {
    const slots = svc.listSlots(MONDAY, "whitening");
    expect(slots.ok && slots.value.at(-1)).toBe("17:00");
  });

  it("respects the minimum notice", () => {
    clock.advance(90 * 60_000); // 09:30
    const slots = svc.listSlots(MONDAY, "checkup");
    expect(slots.ok && slots.value[0]).toBe("10:30");
  });

  it("removes slots that overlap an existing booking", () => {
    expect(svc.book(ALICE, "whitening", `${MONDAY}T10:00`, "Alice Example").ok).toBe(true);
    const slots = svc.listSlots(MONDAY, "checkup");
    expect(slots.ok && slots.value).not.toContain("10:00");
    expect(slots.ok && slots.value).not.toContain("10:30");
    expect(slots.ok && slots.value).toContain("11:00");
    const hour = svc.listSlots(MONDAY, "filling");
    expect(hour.ok && hour.value).not.toContain("09:30");
  });

  it.each([
    ["2026-11-15", "closed"],
    ["2026-11-08", "past"],
    ["2026-12-31", "30 days"],
    ["2026-02-30", "real calendar date"],
  ])("refuses %s (%s)", (date, why) => {
    const res = svc.listSlots(date, "checkup");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(why);
  });

  it("rejects unknown services and taken times", () => {
    expect(svc.listSlots(MONDAY, "tattoo")).toEqual({ ok: false, error: 'Unknown service "tattoo".' });
    expect(svc.book(ALICE, "checkup", `${MONDAY}T09:00`, "Alice Example").ok).toBe(true);
    const second = svc.book(BOB, "checkup", `${MONDAY}T09:00`, "Bob Example");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/not available.*09:30/);
  });

  it("validates the name and the time format", () => {
    expect(svc.book(ALICE, "checkup", `${MONDAY}T09:00`, " ").ok).toBe(false);
    expect(svc.book(ALICE, "checkup", `${MONDAY} 09:00`, "Alice").ok).toBe(false);
    expect(svc.book(ALICE, "checkup", `${MONDAY}T09:15`, "Alice").ok).toBe(false);
  });

  it("limits upcoming bookings per number", () => {
    expect(svc.book(ALICE, "checkup", `${MONDAY}T09:00`, "Alice").ok).toBe(true);
    expect(svc.book(ALICE, "checkup", `${MONDAY}T10:00`, "Alice").ok).toBe(true);
    const third = svc.book(ALICE, "checkup", `${MONDAY}T11:00`, "Alice");
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.error).toContain("limit 2");
  });

  it("cancels only the caller's own upcoming bookings", () => {
    const booked = svc.book(ALICE, "checkup", `${MONDAY}T09:00`, "Alice");
    if (!booked.ok) throw new Error(booked.error);
    const id = booked.value.id;

    expect(svc.cancel(BOB, id)).toEqual({ ok: false, error: `No booking #${id} found for this number.` });
    expect(svc.cancel(ALICE, id).ok).toBe(true);
    expect(svc.cancel(ALICE, id)).toEqual({ ok: false, error: `Booking #${id} is already cancelled.` });
    expect(svc.listSlots(MONDAY, "checkup").ok && svc.upcomingFor(ALICE)).toEqual([]);
  });

  it("does not cancel past bookings", () => {
    const booked = svc.book(ALICE, "checkup", `${MONDAY}T09:00`, "Alice");
    if (!booked.ok) throw new Error(booked.error);
    clock.advance(3 * 60 * 60_000);
    expect(svc.cancel(ALICE, booked.value.id).ok).toBe(false);
  });
});

describe("searchFaq", () => {
  const { faq } = sampleClinic(TIME_ZONE);

  it.each([
    ["Where can I park my car?", "parking"],
    ["what time do you open on saturday", "hours"],
    ["Do you take insurance", "insurance"],
    ["I have terrible toothache", "emergency"],
  ])("%s -> %s", (question, id) => {
    expect(searchFaq(faq, question)[0]?.id).toBe(id);
  });

  it("returns nothing for unrelated questions", () => {
    expect(searchFaq(faq, "Do you sell bicycles?")).toEqual([]);
  });
});

describe("time helpers", () => {
  it("converts to clinic wall-clock time", () => {
    expect(localNow("Europe/Berlin", new Date("2026-11-09T07:00:00Z"))).toEqual({ date: MONDAY, time: "08:00" });
    expect(localNow("Europe/Berlin", new Date("2026-07-01T07:00:00Z"))).toEqual({ date: "2026-07-01", time: "09:00" });
  });

  it("adds minutes and days across boundaries", () => {
    expect(addMinutes("2026-12-31T23:30", 45)).toBe("2027-01-01T00:15");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("validates dates and stamps", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidStamp("2026-11-09T24:00")).toBe(false);
    expect(isoWeekday(MONDAY)).toBe(1);
    expect(isoWeekday("2026-11-15")).toBe(7);
  });
});
