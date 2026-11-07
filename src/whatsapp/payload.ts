import { z } from "zod";

/**
 * The parts of the WhatsApp Cloud API webhook payload this app reads. Unknown fields are ignored,
 * so new fields from Meta do not break parsing.
 */
const messageSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  button: z.object({ text: z.string() }).optional(),
  interactive: z
    .object({
      button_reply: z.object({ title: z.string() }).optional(),
      list_reply: z.object({ title: z.string() }).optional(),
    })
    .optional(),
});

const valueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({ phone_number_id: z.string() }),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
  messages: z.array(messageSchema).optional(),
  statuses: z.array(z.unknown()).optional(),
});

export const webhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: valueSchema })),
    }),
  ),
});

export type WebhookPayload = z.infer<typeof webhookSchema>;

export interface InboundMessage {
  id: string;
  from: string;
  profileName: string | null;
  /** Text the user typed or the title of the button they tapped; null for media, location, etc. */
  text: string | null;
  type: string;
  phoneNumberId: string;
}

export function extractMessages(payload: WebhookPayload): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const { value } = change;
      for (const m of value.messages ?? []) {
        const profileName = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        out.push({
          id: m.id,
          from: m.from,
          profileName,
          type: m.type,
          text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null,
          phoneNumberId: value.metadata.phone_number_id,
        });
      }
    }
  }
  return out;
}
