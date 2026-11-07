import type { WhatsAppSender } from "../whatsapp/graph.js";

export type ThreadEntry =
  | { seq: number; at: number; direction: "in"; waId: string; text: string }
  | { seq: number; at: number; direction: "out"; waId: string; kind: "text"; text: string }
  | { seq: number; at: number; direction: "out"; waId: string; kind: "template"; template: string };

type NewEntry = ThreadEntry extends infer E ? (E extends ThreadEntry ? Omit<E, "seq" | "at"> : never) : never;

/**
 * Demo stand-in for the WhatsApp side: records what the simulated phone sent and what the server would have
 * sent through the Graph API, per number. In memory only, capped so a long demo session cannot grow forever.
 */
export class DemoOutbox implements WhatsAppSender {
  private readonly entries: ThreadEntry[] = [];
  private seq = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxEntries = 2000,
  ) {}

  recordInbound(waId: string, text: string): ThreadEntry {
    return this.push({ direction: "in", waId, text });
  }

  sendText(to: string, body: string): Promise<void> {
    this.push({ direction: "out", waId: to, kind: "text", text: body });
    return Promise.resolve();
  }

  sendTemplate(to: string, name: string): Promise<void> {
    this.push({ direction: "out", waId: to, kind: "template", template: name });
    return Promise.resolve();
  }

  /** Entries for one number with seq greater than `after`, oldest first. */
  thread(waId: string, after = 0): ThreadEntry[] {
    return this.entries.filter((e) => e.waId === waId && e.seq > after);
  }

  private push(entry: NewEntry): ThreadEntry {
    const full = { ...entry, seq: ++this.seq, at: this.now().getTime() };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return full;
  }
}
