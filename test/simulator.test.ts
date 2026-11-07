import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DemoOutbox } from "../src/demo/outbox.js";
import { simulatorRouter } from "../src/demo/simulator.js";
import { silentLogger } from "../src/logger.js";
import { APP_SECRET, createHarness, listen, PHONE_NUMBER_ID, say } from "./helpers.js";

const publicDir = fileURLToPath(new URL("../public", import.meta.url));

function setup(appSecret = APP_SECRET) {
  const outbox = new DemoOutbox();
  const h = createHarness({
    sender: outbox,
    mount: (app) =>
      app.use(
        "/simulator",
        simulatorRouter({ outbox, appSecret, phoneNumberId: PHONE_NUMBER_ID, clinicName: "Sample", model: "demo", publicDir, logger: silentLogger }),
      ),
  });
  return { h, outbox };
}

describe("phone simulator", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  async function start(appSecret?: string) {
    const { h, outbox } = setup(appSecret);
    const server = await listen(h.app);
    cleanup = async () => {
      await server.close();
      h.store.close();
    };
    const post = (body: unknown) =>
      fetch(`${server.url}/simulator/api/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { h, outbox, url: server.url, post };
  }

  it("sends a signed webhook to the server and shows the reply in the thread", async () => {
    const { h, url, post } = await start();
    h.llm.then(say("Hello from the clinic"));

    const res = await post({ waId: "15550100001", name: "Anna", text: "Hi" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ webhookStatus: 200, entry: { direction: "in", text: "Hi" } });
    await h.receptionist.idle();

    const thread = (await (await fetch(`${url}/simulator/api/thread?waId=15550100001`)).json()) as { entries: unknown[] };
    expect(thread.entries).toMatchObject([
      { seq: 1, direction: "in", text: "Hi" },
      { seq: 2, direction: "out", kind: "text", text: "Hello from the clinic" },
    ]);
    const after = (await (await fetch(`${url}/simulator/api/thread?waId=15550100001&after=1`)).json()) as { entries: unknown[] };
    expect(after.entries).toHaveLength(1);
    expect(h.store.getContact("15550100001")?.profileName).toBe("Anna");
  });

  it("goes through signature verification: a wrong secret is rejected by the webhook", async () => {
    const { h, outbox, post } = await start("not-the-app-secret");
    const res = await post({ waId: "15550100001", name: "Anna", text: "Hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ webhookStatus: 401 });
    await h.receptionist.idle();
    expect(h.llm.requests).toHaveLength(0);
    expect(outbox.thread("15550100001").filter((e) => e.direction === "out")).toHaveLength(0);
  });

  it("validates input and serves the page", async () => {
    const { url, post } = await start();
    expect((await post({ waId: "12", name: "Anna", text: "Hi" })).status).toBe(400);
    expect((await post({ waId: "15550100001", name: "Anna", text: "   " })).status).toBe(400);
    expect((await fetch(`${url}/simulator/api/thread?waId=abc`)).status).toBe(400);
    const page = await fetch(`${url}/simulator`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Phone simulator");
  });
});

describe("DemoOutbox", () => {
  it("keeps per-number threads and drops the oldest entries past its cap", async () => {
    const outbox = new DemoOutbox(() => new Date(0), 3);
    outbox.recordInbound("1", "a");
    await outbox.sendText("2", "b");
    await outbox.sendTemplate("1", "hello_world");
    await outbox.sendText("1", "c");
    expect(outbox.thread("1").map((e) => e.seq)).toEqual([3, 4]);
    expect(outbox.thread("2")).toMatchObject([{ kind: "text", text: "b" }]);
  });
});
