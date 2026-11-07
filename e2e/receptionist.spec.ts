import { expect, test, type Page } from "@playwright/test";
import { startDemoServer, type DemoServer } from "./server.js";

/**
 * Whole flow in a real browser against the running server in demo mode:
 * patient books and cancels in the phone simulator, asks for a person, staff answers from the dashboard,
 * resolves the handoff, and the assistant takes over again.
 * SCREENSHOTS=1 also saves the screens used in the README to docs/.
 */
let server: DemoServer;
const screenshots = process.env.SCREENSHOTS === "1";

test.beforeAll(async () => {
  server = await startDemoServer();
});
test.afterAll(async () => {
  await server.stop();
});

async function say(page: Page, text: string): Promise<void> {
  const before = await page.locator(".chat .bubble.in").count();
  await page.getByLabel("Message").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".chat .bubble.out").last()).toContainText(text);
  // Wait for the assistant's answer (a new incoming bubble).
  await expect(page.locator(".chat .bubble.in")).toHaveCount(before + 1);
}

const lastReply = (page: Page) => page.locator(".chat .bubble.in").last();

test("book, cancel, hand off to staff and back", async ({ browser }) => {
  const errors: string[] = [];
  const watch = (page: Page) => page.on("console", (m) => void (m.type() === "error" && errors.push(m.text())));
  const phone = await browser.newPage();
  watch(phone);
  await phone.goto(`${server.url}/simulator`);
  await expect(phone.locator("#model-tag")).toHaveText("Offline demo model");
  await expect(phone.locator("#clinic-name")).toHaveText("Maple Dental (sample clinic)");

  await phone.getByRole("button", { name: "What are your opening hours?" }).click();
  await expect(lastReply(phone)).toContainText("Mon–Thu 09:00–18:00");

  await say(phone, "Book a check-up on Monday");
  await expect(lastReply(phone)).toContainText("Free times for check-up and cleaning on Monday");
  await say(phone, "10:00 for Anna Sample");
  await expect(lastReply(phone)).toContainText("Booked! #1: check-up and cleaning on Monday");
  await expect(phone.locator(".typing")).toHaveCount(0);
  if (screenshots) {
    await phone.getByLabel("Message").blur();
    await phone.screenshot({ path: "docs/simulator-booking.png" });
  }

  await say(phone, "Cancel my booking");
  await expect(lastReply(phone)).toContainText('Which one should I cancel? Send "cancel #1"');
  await say(phone, "cancel #1");
  await expect(lastReply(phone)).toContainText("Booking #1 on");
  await expect(lastReply(phone)).toContainText("is cancelled");

  await say(phone, "Book teeth whitening on Tuesday at 11:00 for Anna Sample");
  await expect(lastReply(phone)).toContainText("Booked! #2: teeth whitening on Tuesday");

  await say(phone, "I have a question about my bill, can I talk to a person?");
  await expect(lastReply(phone)).toContainText("passed your message to our team");

  // Staff side.
  const context = await browser.newContext({ httpCredentials: { username: "admin", password: "demo-admin" } });
  const admin = await context.newPage();
  watch(admin);
  await admin.goto(`${server.url}/admin`);
  await expect(admin.locator("#stat-handoffs")).toHaveText("1");
  await expect(admin.locator("#stat-bookings")).toHaveText("1");
  await expect(admin.locator("#bookings tr.cancelled")).toContainText("Check-up and cleaning");
  await expect(admin.locator("#bookings tr").nth(1)).toContainText("Teeth whitening");

  await admin.locator("#handoffs tr").first().click();
  await expect(admin.locator("#chat-title")).toHaveText("Anna Sample (+15550100001)");
  await expect(admin.locator("#transcript .bubble").last()).toContainText("passed your message to our team");
  await admin.getByLabel("Reply as staff").fill("Hi Anna, this is the reception desk. I'll check the bill now.");
  await admin.getByRole("button", { name: "Send reply" }).click();
  await expect(admin.locator("#reply-note")).toHaveText("Sent.");
  await expect(admin.locator("#transcript .bubble.staff")).toContainText("reception desk");
  if (screenshots) {
    await admin.getByLabel("Reply as staff").blur();
    await admin.screenshot({ path: "docs/admin-handoff.png", fullPage: true });
  }

  // The patient gets the staff message on the phone; the bot stays quiet while staff owns the chat.
  await expect(lastReply(phone)).toContainText("this is the reception desk");

  await admin.getByRole("button", { name: "Resolve and hand back to the bot" }).click();
  await expect(admin.locator("#reply-note")).toHaveText("Resolved. The assistant answers this chat again.");
  await expect(admin.locator("#handoffs .pill")).toHaveText("resolved");

  await say(phone, "Is there parking?");
  await expect(lastReply(phone)).toContainText("free street parking");

  await phone.reload();
  await admin.reload();
  await expect(phone.locator(".chat .bubble").first()).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test("admin pages need a password", async ({ request }) => {
  expect((await request.get(`${server.url}/admin`)).status()).toBe(401);
  expect((await request.get(`${server.url}/admin/api/overview`)).status()).toBe(401);
});
