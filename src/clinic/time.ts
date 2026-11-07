/**
 * Appointment times are stored as clinic wall-clock strings ("YYYY-MM-DDTHH:mm") in the clinic's
 * time zone. Wall-clock arithmetic is done on UTC dates so DST never shifts a slot.
 */

export interface LocalDateTime {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
}

export function localNow(timeZone: string, now: Date): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

export function toStamp({ date, time }: LocalDateTime): string {
  return `${date}T${time}`;
}

const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(date: string): boolean {
  if (!DATE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(date);
}

export function isValidStamp(stamp: string): boolean {
  const m = STAMP.exec(stamp);
  if (!m) return false;
  const [, , , , hh, mm] = m;
  return isValidDate(stamp.slice(0, 10)) && Number(hh) < 24 && Number(mm) < 60;
}

function stampToUtc(stamp: string): Date {
  return new Date(`${stamp}:00Z`);
}

export function addMinutes(stamp: string, minutes: number): string {
  return new Date(stampToUtc(stamp).getTime() + minutes * 60_000).toISOString().slice(0, 16);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day === 0 ? 7 : day) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export function weekdayName(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
}
