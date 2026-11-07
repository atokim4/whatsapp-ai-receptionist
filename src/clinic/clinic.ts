/** Business data the receptionist works with. Everything in sample-clinic.ts is sample data. */

export interface Service {
  id: string;
  name: string;
  durationMinutes: number;
  priceLabel: string;
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
  keywords: string[];
}

/** Opening hours per ISO weekday (1 = Monday … 7 = Sunday), "HH:mm" local time. Missing day = closed. */
export type OpeningHours = Partial<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, { open: string; close: string }>>;

export interface Clinic {
  name: string;
  address: string;
  timeZone: string;
  slotMinutes: number;
  /** How far ahead patients may book. */
  maxDaysAhead: number;
  /** Minimum notice for a new booking. */
  minNoticeMinutes: number;
  maxActiveBookingsPerPatient: number;
  openingHours: OpeningHours;
  services: Service[];
  faq: FaqEntry[];
}
