import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export type ContactMode = "bot" | "human";
export type MessageRole = "user" | "assistant" | "staff";

export interface Contact {
  waId: string;
  profileName: string | null;
  lastInboundAt: number | null;
  optedOut: boolean;
  mode: ContactMode;
}

export interface StoredMessage {
  id: number;
  waId: string;
  role: MessageRole;
  body: string;
  createdAt: number;
}

export interface Booking {
  id: number;
  waId: string;
  patientName: string;
  serviceId: string;
  start: string;
  end: string;
  status: "booked" | "cancelled";
  createdAt: number;
}

export interface ContactSummary extends Contact {
  lastMessageAt: number | null;
  openHandoffId: number | null;
}

export interface Handoff {
  id: number;
  waId: string;
  reason: string;
  status: "open" | "resolved";
  createdAt: number;
  resolvedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  wa_id           TEXT PRIMARY KEY,
  profile_name    TEXT,
  last_inbound_at INTEGER,
  opted_out       INTEGER NOT NULL DEFAULT 0,
  mode            TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human')),
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  wa_id      TEXT NOT NULL REFERENCES contacts(wa_id),
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'staff')),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_by_contact ON messages (wa_id, id);
CREATE TABLE IF NOT EXISTS processed_messages (
  wa_message_id TEXT PRIMARY KEY,
  received_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY,
  wa_id        TEXT NOT NULL REFERENCES contacts(wa_id),
  patient_name TEXT NOT NULL,
  service_id   TEXT NOT NULL,
  start_local  TEXT NOT NULL,
  end_local    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
  created_at   INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS bookings_by_day ON bookings (status, start_local);
CREATE TABLE IF NOT EXISTS handoffs (
  id          INTEGER PRIMARY KEY,
  wa_id       TEXT NOT NULL REFERENCES contacts(wa_id),
  reason      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER
);
`;

type Row = Record<string, SQLOutputValue>;

type Cell = SQLOutputValue | undefined;

const text = (v: Cell): string => (typeof v === "string" ? v : String(v));
const num = (v: Cell): number => Number(v);
const textOrNull = (v: Cell): string | null => (v == null ? null : text(v));
const numOrNull = (v: Cell): number | null => (v == null ? null : num(v));

const toContact = (r: Row): Contact => ({
  waId: text(r.wa_id),
  profileName: textOrNull(r.profile_name),
  lastInboundAt: numOrNull(r.last_inbound_at),
  optedOut: num(r.opted_out) === 1,
  mode: r.mode === "human" ? "human" : "bot",
});

const toMessage = (r: Row): StoredMessage => ({
  id: num(r.id),
  waId: text(r.wa_id),
  role: text(r.role) as MessageRole,
  body: text(r.body),
  createdAt: num(r.created_at),
});

const toBooking = (r: Row): Booking => ({
  id: num(r.id),
  waId: text(r.wa_id),
  patientName: text(r.patient_name),
  serviceId: text(r.service_id),
  start: text(r.start_local),
  end: text(r.end_local),
  status: r.status === "cancelled" ? "cancelled" : "booked",
  createdAt: num(r.created_at),
});

const toHandoff = (r: Row): Handoff => ({
  id: num(r.id),
  waId: text(r.wa_id),
  reason: text(r.reason),
  status: r.status === "resolved" ? "resolved" : "open",
  createdAt: num(r.created_at),
  resolvedAt: numOrNull(r.resolved_at),
});

/**
 * All persistence in one place. node:sqlite is synchronous, so each method is atomic with
 * respect to the event loop: a check-then-insert inside one method cannot interleave with another request.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Returns true the first time a WhatsApp message id is seen, false for a redelivery. */
  markProcessed(waMessageId: string, now: number): boolean {
    const res = this.db
      .prepare("INSERT OR IGNORE INTO processed_messages (wa_message_id, received_at) VALUES (?, ?)")
      .run(waMessageId, now);
    return Number(res.changes) === 1;
  }

  upsertContactOnInbound(waId: string, profileName: string | null, now: number): Contact {
    this.db
      .prepare(
        `INSERT INTO contacts (wa_id, profile_name, last_inbound_at, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (wa_id) DO UPDATE SET
           profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
           last_inbound_at = excluded.last_inbound_at`,
      )
      .run(waId, profileName, now, now);
    return this.requireContact(waId);
  }

  getContact(waId: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE wa_id = ?").get(waId);
    return row ? toContact(row) : null;
  }

  private requireContact(waId: string): Contact {
    const contact = this.getContact(waId);
    if (!contact) throw new Error("contact not found");
    return contact;
  }

  setOptedOut(waId: string, optedOut: boolean): void {
    this.db.prepare("UPDATE contacts SET opted_out = ? WHERE wa_id = ?").run(optedOut ? 1 : 0, waId);
  }

  setMode(waId: string, mode: ContactMode): void {
    this.db.prepare("UPDATE contacts SET mode = ? WHERE wa_id = ?").run(mode, waId);
  }

  addMessage(waId: string, role: MessageRole, body: string, now: number): void {
    this.db
      .prepare("INSERT INTO messages (wa_id, role, body, created_at) VALUES (?, ?, ?, ?)")
      .run(waId, role, body, now);
  }

  /** Contacts for the staff view, most recently active first. */
  listContacts(limit = 100): ContactSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.*,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.wa_id = c.wa_id) AS last_message_at,
           (SELECT h.id FROM handoffs h WHERE h.wa_id = c.wa_id AND h.status = 'open') AS open_handoff_id
         FROM contacts c
         ORDER BY COALESCE(last_message_at, c.created_at) DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((r) => ({ ...toContact(r), lastMessageAt: numOrNull(r.last_message_at), openHandoffId: numOrNull(r.open_handoff_id) }));
  }

  /** Most recent messages since `since`, oldest first. */
  recentMessages(waId: string, since: number, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE wa_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?")
      .all(waId, since, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  /** Booked (not cancelled) appointments that overlap [start, end) — wall-clock strings compare lexically. */
  overlappingBookings(start: string, end: string): Booking[] {
    const rows = this.db
      .prepare("SELECT * FROM bookings WHERE status = 'booked' AND start_local < ? AND end_local > ?")
      .all(end, start) as Row[];
    return rows.map(toBooking);
  }

  bookingsOnDay(date: string): Booking[] {
    const rows = this.db
      .prepare("SELECT * FROM bookings WHERE status = 'booked' AND substr(start_local, 1, 10) = ? ORDER BY start_local")
      .all(date) as Row[];
    return rows.map(toBooking);
  }

  upcomingBookingsFor(waId: string, fromStamp: string): Booking[] {
    const rows = this.db
      .prepare("SELECT * FROM bookings WHERE wa_id = ? AND status = 'booked' AND start_local >= ? ORDER BY start_local")
      .all(waId, fromStamp) as Row[];
    return rows.map(toBooking);
  }

  insertBooking(b: Omit<Booking, "id" | "status">): Booking {
    const res = this.db
      .prepare(
        "INSERT INTO bookings (wa_id, patient_name, service_id, start_local, end_local, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(b.waId, b.patientName, b.serviceId, b.start, b.end, b.createdAt);
    return { ...b, id: Number(res.lastInsertRowid), status: "booked" };
  }

  getBooking(id: number): Booking | null {
    const row = this.db.prepare("SELECT * FROM bookings WHERE id = ?").get(id);
    return row ? toBooking(row) : null;
  }

  cancelBooking(id: number, now: number): void {
    this.db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").run(now, id);
  }

  listBookings(fromStamp: string): Booking[] {
    const rows = this.db
      .prepare("SELECT * FROM bookings WHERE start_local >= ? ORDER BY start_local")
      .all(fromStamp) as Row[];
    return rows.map(toBooking);
  }

  openHandoff(waId: string, reason: string, now: number): Handoff {
    const existing = this.db
      .prepare("SELECT * FROM handoffs WHERE wa_id = ? AND status = 'open'")
      .get(waId);
    if (existing) return toHandoff(existing);
    const res = this.db
      .prepare("INSERT INTO handoffs (wa_id, reason, created_at) VALUES (?, ?, ?)")
      .run(waId, reason, now);
    this.setMode(waId, "human");
    return { id: Number(res.lastInsertRowid), waId, reason, status: "open", createdAt: now, resolvedAt: null };
  }

  getHandoff(id: number): Handoff | null {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id);
    return row ? toHandoff(row) : null;
  }

  /** Closes the handoff and gives the conversation back to the bot. */
  resolveHandoff(id: number, now: number): Handoff | null {
    const handoff = this.getHandoff(id);
    if (!handoff) return null;
    if (handoff.status === "open") {
      this.db.prepare("UPDATE handoffs SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now, id);
      this.setMode(handoff.waId, "bot");
    }
    return this.getHandoff(id);
  }

  listHandoffs(): Handoff[] {
    const rows = this.db.prepare("SELECT * FROM handoffs ORDER BY status = 'resolved', created_at DESC").all() as Row[];
    return rows.map(toHandoff);
  }
}
