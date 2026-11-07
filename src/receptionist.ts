import type Anthropic from "@anthropic-ai/sdk";
import type { AgentInput, AgentTurn } from "./agent/agent.js";
import { buildSystemPrompt } from "./agent/prompt.js";
import type { BookingService } from "./clinic/booking.js";
import type { Clinic } from "./clinic/clinic.js";
import { errorMessage, maskPhone, type Logger } from "./logger.js";
import { KeyedQueue } from "./queue.js";
import type { RateLimiter } from "./rate-limit.js";
import type { StoredMessage, Store } from "./store.js";
import { SERVICE_WINDOW_MS, type Messenger } from "./whatsapp/messenger.js";
import type { InboundMessage } from "./whatsapp/payload.js";

const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "STOP ALL", "OPT OUT", "СТОП"]);
const START_WORDS = new Set(["START", "SUBSCRIBE", "OPT IN", "СТАРТ"]);
const HISTORY_LIMIT = 20;

export const TEXTS = {
  optedOut: "You won't get any more messages from us. Send START at any time to turn them back on.",
  optedIn: "Welcome back! Messages are on again. How can I help?",
  rateLimited: "You're sending messages very quickly. Please wait a minute and I'll be right with you.",
  unsupported: "Sorry, I can only read text messages for now. Please type your question.",
} as const;

export interface ReceptionistDeps {
  store: Store;
  clinic: Clinic;
  bookings: BookingService;
  messenger: Messenger;
  rateLimiter: RateLimiter;
  agent: (input: AgentInput) => Promise<AgentTurn>;
  logger: Logger;
  now: () => Date;
}

export class Receptionist {
  private readonly queue: KeyedQueue;

  constructor(private readonly deps: ReceptionistDeps) {
    this.queue = new KeyedQueue((err, waId) =>
      deps.logger.error("message handling failed", { error: errorMessage(err), from: maskPhone(waId) }),
    );
  }

  /**
   * Called from the webhook before it answers 200. Drops redeliveries (Meta retries until it gets a 200)
   * and queues the rest for background processing. Returns how many messages were new.
   */
  accept(messages: InboundMessage[]): number {
    let accepted = 0;
    for (const message of messages) {
      if (!this.deps.store.markProcessed(message.id, this.deps.now().getTime())) continue;
      accepted++;
      this.queue.push(message.from, () => this.handle(message));
    }
    return accepted;
  }

  idle(): Promise<void> {
    return this.queue.idle();
  }

  private async handle(message: InboundMessage): Promise<void> {
    const { store, messenger, logger } = this.deps;
    const now = this.deps.now().getTime();
    const waId = message.from;
    const contact = store.upsertContactOnInbound(waId, message.profileName, now);
    const text = message.text?.trim() || null;
    const keyword = text?.toUpperCase().replace(/\s+/g, " ");

    if (keyword && STOP_WORDS.has(keyword)) {
      store.setOptedOut(waId, true);
      await messenger.send(waId, TEXTS.optedOut, { ignoreOptOut: true });
      logger.info("opted out", { from: maskPhone(waId) });
      return;
    }
    if (keyword && START_WORDS.has(keyword) && contact.optedOut) {
      store.setOptedOut(waId, false);
      await messenger.send(waId, TEXTS.optedIn);
      return;
    }
    if (contact.optedOut) return;

    const rate = this.deps.rateLimiter.check(waId, now);
    if (rate !== "allow") {
      if (rate === "warn") await messenger.send(waId, TEXTS.rateLimited);
      logger.warn("rate limited", { from: maskPhone(waId) });
      return;
    }

    if (!text) {
      await messenger.send(waId, TEXTS.unsupported);
      return;
    }

    store.addMessage(waId, "user", text, now);
    // A staff member owns this conversation; the message waits for them in the admin view.
    if (contact.mode === "human") return;

    const turn = await this.deps.agent({
      system: buildSystemPrompt(this.deps.clinic, this.deps.now()),
      history: toModelHistory(store.recentMessages(waId, now - SERVICE_WINDOW_MS, HISTORY_LIMIT)),
      context: { waId, clinic: this.deps.clinic, bookings: this.deps.bookings },
    });

    if (turn.handoffReason) {
      const handoff = store.openHandoff(waId, turn.handoffReason, this.deps.now().getTime());
      logger.info("handoff opened", { handoffId: handoff.id, from: maskPhone(waId) });
    }
    store.addMessage(waId, "assistant", turn.reply, this.deps.now().getTime());
    await messenger.send(waId, turn.reply);
  }
}

/**
 * Session memory: the last messages of the current 24h window as plain text turns. Staff replies count
 * as assistant turns. Consecutive same-role messages are merged and the history starts with a user turn,
 * as the Messages API requires.
 */
export function toModelHistory(messages: StoredMessage[]): Anthropic.MessageParam[] {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const role = m.role === "user" ? "user" : "assistant";
    const body = m.role === "staff" ? `[Staff member] ${m.body}` : m.body;
    const last = history.at(-1);
    if (last?.role === role) last.content += `\n${body}`;
    else if (history.length > 0 || role === "user") history.push({ role, content: body });
  }
  return history;
}
