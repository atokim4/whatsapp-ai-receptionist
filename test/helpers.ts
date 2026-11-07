import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type Anthropic from "@anthropic-ai/sdk";
import type { Express } from "express";
import type { Clinic } from "../src/clinic/clinic.js";
import { runAgent } from "../src/agent/agent.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/agent/llm.js";
import { BookingService } from "../src/clinic/booking.js";
import { sampleClinic } from "../src/clinic/sample-clinic.js";
import { silentLogger } from "../src/logger.js";
import { RateLimiter } from "../src/rate-limit.js";
import { Receptionist } from "../src/receptionist.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import type { WhatsAppSender } from "../src/whatsapp/graph.js";
import { Messenger } from "../src/whatsapp/messenger.js";
import { signBody } from "../src/whatsapp/signature.js";

export const APP_SECRET = "test-app-secret";
export const VERIFY_TOKEN = "test-verify-token";
export const PHONE_NUMBER_ID = "100200300";
export const TIME_ZONE = "Europe/Berlin";
/** Monday 2026-11-09 08:00 in Berlin (UTC+1). */
export const MONDAY_8AM = new Date("2026-11-09T07:00:00Z");

export class Clock {
  constructor(private current: Date = MONDAY_8AM) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export type Sent = { to: string; kind: "text"; body: string } | { to: string; kind: "template"; name: string };

export class FakeSender implements WhatsAppSender {
  readonly sent: Sent[] = [];
  sendText(to: string, body: string): Promise<void> {
    this.sent.push({ to, kind: "text", body });
    return Promise.resolve();
  }
  sendTemplate(to: string, name: string): Promise<void> {
    this.sent.push({ to, kind: "template", name });
    return Promise.resolve();
  }
}

type Step = (request: LlmRequest) => LlmResponse;

/** Deterministic stand-in for Claude: plays scripted responses in order and records every request. */
export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly steps: Step[] = [];

  then(...steps: (Step | LlmResponse)[]): this {
    for (const s of steps) this.steps.push(typeof s === "function" ? s : () => s);
    return this;
  }

  create(request: LlmRequest): Promise<LlmResponse> {
    // Snapshot: the agent keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("ScriptedLlm: no response scripted"));
    return Promise.resolve(step(request));
  }

  get remaining(): number {
    return this.steps.length;
  }
}

export const say = (text: string): LlmResponse => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text, citations: null }],
});

let toolCallId = 0;
export const callTool = (name: string, input: unknown): LlmResponse => ({
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: `toolu_${++toolCallId}`, name, input, caller: { type: "direct" } }],
});

/** The tool_result blocks the agent sent back in its latest request. */
export function lastToolResults(llm: ScriptedLlm): Anthropic.ToolResultBlockParam[] {
  const last = llm.requests.at(-1)?.messages.at(-1);
  if (!last || typeof last.content === "string") return [];
  return last.content.flatMap((b) => (b.type === "tool_result" ? [b] : []));
}

/** Parsed JSON of a tool_result produced by executeTool (always a string). */
export function resultJson(block: Anthropic.ToolResultBlockParam | undefined): unknown {
  if (typeof block?.content !== "string") throw new Error("expected a string tool result");
  return JSON.parse(block.content);
}

export function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected a string request body");
  return JSON.parse(init.body);
}

export interface HarnessOptions {
  rateLimit?: number;
  /** Model used by the agent instead of the ScriptedLlm (e.g. the DemoLlm). */
  llm?: (clinic: Clinic) => LlmClient;
  /** Outbound side instead of FakeSender. */
  sender?: WhatsAppSender;
  mount?: (app: Express, parts: { store: Store; clinic: Clinic; messenger: Messenger; clock: Clock }) => void;
}

export function createHarness(opts: HarnessOptions = {}) {
  const clock = new Clock();
  const store = new Store(":memory:");
  const clinic = sampleClinic(TIME_ZONE);
  const bookings = new BookingService(clinic, store, clock.now);
  const sender = new FakeSender();
  const messenger = new Messenger(opts.sender ?? sender, store, { templateName: "hello_world", templateLanguage: "en_US" }, clock.now);
  const llm = new ScriptedLlm();
  const agentLlm = opts.llm?.(clinic) ?? llm;
  const receptionist = new Receptionist({
    store,
    clinic,
    bookings,
    messenger,
    rateLimiter: new RateLimiter(opts.rateLimit ?? 8),
    agent: (input) => runAgent({ llm: agentLlm, model: "test-model", effort: "low", logger: silentLogger }, input),
    logger: silentLogger,
    now: clock.now,
  });
  const app = createApp({
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    phoneNumberId: PHONE_NUMBER_ID,
    onMessages: (m) => receptionist.accept(m),
    logger: silentLogger,
    mount: opts.mount && ((app) => opts.mount?.(app, { store, clinic, messenger, clock })),
  });
  return { clock, store, clinic, bookings, sender, messenger, llm, receptionist, app };
}

export async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

let messageSeq = 0;

export function textPayload(from: string, text: string, id = `wamid.TEST${++messageSeq}`, phoneNumberId = PHONE_NUMBER_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: phoneNumberId },
              contacts: [{ wa_id: from, profile: { name: "Sample User" } }],
              messages: [{ id, from, timestamp: "1762671600", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  };
}

export async function postSigned(url: string, payload: unknown, secret = APP_SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signBody(body, secret) },
    body,
  });
}
