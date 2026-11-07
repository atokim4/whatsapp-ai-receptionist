import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import { errorMessage } from "../logger.js";
import type { LlmClient } from "./llm.js";
import { executeTool, toolDefinitions, type ToolContext } from "./tools.js";

export interface AgentOptions {
  llm: LlmClient;
  model: string;
  effort: "low" | "medium" | "high";
  logger: Logger;
  /** Upper bound on model calls per incoming message. */
  maxSteps?: number;
}

export interface AgentInput {
  system: Anthropic.TextBlockParam[];
  /** Conversation so far, alternating, ending with the new user message. */
  history: Anthropic.MessageParam[];
  context: Omit<ToolContext, "requestHandoff">;
}

export interface AgentTurn {
  reply: string;
  /** Set when the model called handoff_to_human, or the agent gave up and escalated. */
  handoffReason: string | null;
}

export const FALLBACK_REPLY =
  "Sorry, I couldn't handle that automatically. I've passed your message to our team and someone will reply here.";

/** Tool-use loop: call the model, run the tools it asks for, feed the results back, until it answers. */
export async function runAgent(opts: AgentOptions, input: AgentInput): Promise<AgentTurn> {
  const maxSteps = opts.maxSteps ?? 6;
  const messages: Anthropic.MessageParam[] = [...input.history];
  let handoffReason: string | null = null;
  const context: ToolContext = {
    ...input.context,
    requestHandoff: (reason) => {
      handoffReason = reason;
    },
  };
  const escalate = (why: string): AgentTurn => ({ reply: FALLBACK_REPLY, handoffReason: handoffReason ?? why });

  for (let step = 0; step < maxSteps; step++) {
    let response;
    try {
      response = await opts.llm.create({
        model: opts.model,
        max_tokens: 2048,
        system: input.system,
        tools: toolDefinitions,
        messages,
        output_config: { effort: opts.effort },
      });
    } catch (err) {
      opts.logger.error("llm call failed", { error: errorMessage(err), step });
      return escalate("The assistant could not reach the language model.");
    }

    switch (response.stop_reason) {
      case "tool_use": {
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = response.content
          .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
          .map((call) => {
            const outcome = executeTool(call.name, call.input, context);
            opts.logger.info("tool call", { tool: call.name, isError: outcome.isError });
            return { type: "tool_result", tool_use_id: call.id, content: outcome.content, is_error: outcome.isError };
          });
        // All results go back in one user message, as the API expects for parallel calls.
        messages.push({ role: "user", content: results });
        continue;
      }
      case "pause_turn":
        messages.push({ role: "assistant", content: response.content });
        continue;
      case "refusal":
        opts.logger.warn("model refused", { step });
        return escalate("The assistant declined to answer this message.");
      default: {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (!text) return escalate("The assistant produced an empty reply.");
        return { reply: text, handoffReason };
      }
    }
  }

  opts.logger.warn("agent step limit reached", { maxSteps });
  return escalate("The assistant hit its step limit on this message.");
}
