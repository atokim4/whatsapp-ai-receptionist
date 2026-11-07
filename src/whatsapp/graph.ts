/** Outbound side of the WhatsApp Cloud API: POST /{version}/{phone-number-id}/messages. */

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<void>;
  sendTemplate(to: string, name: string, languageCode: string): Promise<void>;
}

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  phoneNumberId: string;
  accessToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts for 429 / 5xx / network errors. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** WhatsApp rejects text bodies longer than 4096 characters. */
export const MAX_TEXT_LENGTH = 4096;

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

export class GraphClient implements WhatsAppSender {
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: GraphClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.url = `${opts.baseUrl.replace(/\/$/, "")}/${opts.version}/${opts.phoneNumberId}/messages`;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  sendText(to: string, body: string): Promise<void> {
    const text = body.length > MAX_TEXT_LENGTH ? `${body.slice(0, MAX_TEXT_LENGTH - 1)}…` : body;
    return this.post({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: text } });
  }

  sendTemplate(to: string, name: string, languageCode: string): Promise<void> {
    return this.post({ messaging_product: "whatsapp", to, type: "template", template: { name, language: { code: languageCode } } });
  }

  private async post(payload: unknown): Promise<void> {
    const attempts = 1 + (this.opts.retries ?? 2);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.postOnce(payload);
        return;
      } catch (err) {
        const retryable = !(err instanceof GraphApiError) || err.retryable;
        if (!retryable || attempt >= attempts) throw err;
        await this.sleep(250 * 2 ** (attempt - 1));
      }
    }
  }

  private async postOnce(payload: unknown): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.ok) return;
    const detail = await res.text().catch(() => "");
    throw new GraphApiError(
      `Graph API ${res.status}: ${detail.slice(0, 300)}`,
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
}
