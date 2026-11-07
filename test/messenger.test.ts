import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { KeyedQueue } from "../src/queue.js";
import { toModelHistory } from "../src/receptionist.js";
import type { StoredMessage } from "../src/store.js";
import { Store } from "../src/store.js";
import { GraphApiError, GraphClient, MAX_TEXT_LENGTH } from "../src/whatsapp/graph.js";
import { Messenger, SERVICE_WINDOW_MS } from "../src/whatsapp/messenger.js";
import { Clock, FakeSender, jsonBody } from "./helpers.js";

const ALICE = "15550000001";

describe("Messenger (24-hour window and opt-out)", () => {
  const setup = () => {
    const clock = new Clock();
    const store = new Store(":memory:");
    const sender = new FakeSender();
    const messenger = new Messenger(sender, store, { templateName: "appointment_update", templateLanguage: "en" }, clock.now);
    store.upsertContactOnInbound(ALICE, null, clock.now().getTime());
    return { clock, store, sender, messenger };
  };

  it("sends free text inside the window", async () => {
    const { sender, messenger } = setup();
    expect(await messenger.send(ALICE, "Your visit is confirmed")).toBe("text");
    expect(sender.sent).toEqual([{ to: ALICE, kind: "text", body: "Your visit is confirmed" }]);
  });

  it("falls back to the approved template once 24 hours have passed", async () => {
    const { clock, sender, messenger } = setup();
    clock.advance(SERVICE_WINDOW_MS);
    expect(await messenger.send(ALICE, "Staff reply")).toBe("template");
    expect(sender.sent).toEqual([{ to: ALICE, kind: "template", name: "appointment_update" }]);
  });

  it("never messages opted-out or unknown numbers", async () => {
    const { store, sender, messenger } = setup();
    store.setOptedOut(ALICE, true);
    expect(await messenger.send(ALICE, "hi")).toBe("skipped_opted_out");
    expect(await messenger.send("15559999999", "hi")).toBe("skipped_unknown_contact");
    expect(sender.sent).toHaveLength(0);
  });
});

describe("GraphClient", () => {
  const ok = () => new Response('{"messages":[{"id":"wamid.X"}]}', { status: 200 });
  const make = (fetchImpl: typeof fetch) =>
    new GraphClient({
      baseUrl: "https://graph.example.test/",
      version: "v24.0",
      phoneNumberId: "100200300",
      accessToken: "test-token",
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

  it("posts a text message to the phone number's messages endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await make(fetchMock).sendText(ALICE, "Hello");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.example.test/v24.0/100200300/messages");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(jsonBody(init)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: ALICE,
      type: "text",
      text: { body: "Hello" },
    });
  });

  it("sends templates with a language code", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await make(fetchMock).sendTemplate(ALICE, "hello_world", "en_US");
    expect(jsonBody(fetchMock.mock.calls[0]![1])).toMatchObject({
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    });
  });

  it("truncates text to WhatsApp's limit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await make(fetchMock).sendText(ALICE, "x".repeat(5000));
    const body = jsonBody(fetchMock.mock.calls[0]![1]) as { text: { body: string } };
    expect(body.text.body).toHaveLength(MAX_TEXT_LENGTH);
  });

  it("retries 5xx and network errors, then succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok());
    await make(fetchMock).sendText(ALICE, "Hello");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":{"code":131047}}', { status: 400 }));
    const err = await make(fetchMock).sendText(ALICE, "Hello").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphApiError);
    expect((err as GraphApiError).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("toModelHistory", () => {
  const msg = (role: StoredMessage["role"], body: string): StoredMessage => ({ id: 0, waId: ALICE, role, body, createdAt: 0 });

  it("starts with a user turn, merges repeats and labels staff replies", () => {
    expect(
      toModelHistory([
        msg("assistant", "old reply"),
        msg("user", "hi"),
        msg("user", "anyone there?"),
        msg("staff", "Yes, this is the front desk"),
        msg("user", "thanks"),
      ]),
    ).toEqual([
      { role: "user", content: "hi\nanyone there?" },
      { role: "assistant", content: "[Staff member] Yes, this is the front desk" },
      { role: "user", content: "thanks" },
    ]);
  });
});

describe("KeyedQueue", () => {
  it("runs tasks for one key in order and isolates failures", async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const queue = new KeyedQueue((err) => errors.push(err));
    const later = (label: string, ms: number) => () =>
      new Promise<void>((resolve) => setTimeout(() => (order.push(label), resolve()), ms));

    queue.push("a", later("a1", 20));
    queue.push("a", () => Promise.reject(new Error("boom")));
    queue.push("a", later("a2", 0));
    queue.push("b", later("b1", 5));
    await queue.idle();

    expect(order).toEqual(["b1", "a1", "a2"]);
    expect(errors).toHaveLength(1);
  });
});

describe("loadConfig", () => {
  const valid = {
    WHATSAPP_VERIFY_TOKEN: "verify-token-123",
    WHATSAPP_APP_SECRET: "secret",
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_PHONE_NUMBER_ID: "100200300",
  };

  it("applies defaults", () => {
    expect(loadConfig(valid)).toMatchObject({ PORT: 3000, ANTHROPIC_MODEL: "claude-haiku-5-5", GRAPH_API_VERSION: "v24.0" });
  });

  it("lists every problem at once", () => {
    expect(() => loadConfig({ WHATSAPP_PHONE_NUMBER_ID: "abc" })).toThrow(
      /WHATSAPP_VERIFY_TOKEN[\s\S]*WHATSAPP_APP_SECRET[\s\S]*WHATSAPP_PHONE_NUMBER_ID must be numeric/,
    );
  });

  it("treats empty values as unset", () => {
    expect(() => loadConfig({ ...valid, WHATSAPP_APP_SECRET: "" })).toThrow(/WHATSAPP_APP_SECRET is required/);
    const config = loadConfig({ ...valid, ADMIN_PASSWORD: "", ANTHROPIC_API_KEY: "" });
    expect(config.ADMIN_PASSWORD).toBeUndefined();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("needs no WhatsApp credentials in demo mode and keeps the app secret random", () => {
    const a = loadConfig({ DEMO_MODE: "1", ADMIN_PASSWORD: "" });
    const b = loadConfig({ DEMO_MODE: "1" });
    expect(a).toMatchObject({ DEMO_MODE: true, ADMIN_PASSWORD: "demo-admin", DATABASE_PATH: "./data/demo.db" });
    expect(a.WHATSAPP_APP_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(a.WHATSAPP_APP_SECRET).not.toBe(b.WHATSAPP_APP_SECRET);
    expect(loadConfig(valid).DEMO_MODE).toBe(false);
  });

  it("rejects a short admin password", () => {
    expect(() => loadConfig({ ...valid, ADMIN_PASSWORD: "short" })).toThrow(/ADMIN_PASSWORD must be at least 8/);
  });

  it("rejects an unknown time zone", () => {
    expect(() => loadConfig({ ...valid, CLINIC_TIMEZONE: "Mars/Olympus" })).toThrow(/CLINIC_TIMEZONE/);
  });
});
