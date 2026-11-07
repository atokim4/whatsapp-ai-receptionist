import type { Store } from "../store.js";
import type { WhatsAppSender } from "./graph.js";

/** WhatsApp only allows free-form messages within 24 hours of the user's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SendResult = "text" | "template" | "skipped_opted_out" | "skipped_unknown_contact";

export interface MessengerOptions {
  templateName: string;
  templateLanguage: string;
}

/**
 * Every outbound message goes through here so the WhatsApp policy rules live in one place:
 * no messages to opted-out users, and an approved template instead of text outside the 24h window.
 */
export class Messenger {
  constructor(
    private readonly sender: WhatsAppSender,
    private readonly store: Store,
    private readonly opts: MessengerOptions,
    private readonly now: () => Date,
  ) {}

  async send(waId: string, text: string, { ignoreOptOut = false } = {}): Promise<SendResult> {
    const contact = this.store.getContact(waId);
    if (!contact) return "skipped_unknown_contact";
    if (contact.optedOut && !ignoreOptOut) return "skipped_opted_out";

    const windowOpen = contact.lastInboundAt !== null && this.now().getTime() - contact.lastInboundAt < SERVICE_WINDOW_MS;
    if (!windowOpen) {
      await this.sender.sendTemplate(waId, this.opts.templateName, this.opts.templateLanguage);
      return "template";
    }
    await this.sender.sendText(waId, text);
    return "text";
  }
}
