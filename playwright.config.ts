import { defineConfig } from "@playwright/test";

// Uses Playwright's bundled Chromium (`npx playwright install chromium`), or a local Chrome via CHROME_PATH.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
});
