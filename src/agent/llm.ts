import Anthropic from "@anthropic-ai/sdk";

export type LlmRequest = Anthropic.MessageCreateParamsNonStreaming;

/** The slice of a Messages API response the agent loop needs. Lets tests plug in a scripted model. */
export interface LlmResponse {
  content: Anthropic.ContentBlock[];
  stop_reason: Anthropic.StopReason | null;
}

export interface LlmClient {
  create(request: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlm implements LlmClient {
  constructor(private readonly client: Anthropic) {}

  async create(request: LlmRequest): Promise<LlmResponse> {
    const message = await this.client.messages.create(request);
    return { content: message.content, stop_reason: message.stop_reason };
  }
}
