// W0.3 (spike-only). Its own config so the W0.1 smoke run (`npx playwright test`) keeps its
// Chromium-only setup. Three engines, no web server: cors.spec.ts fulfils its page locally.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "cors.spec.ts",
  outputDir: "out/test-results-cors",
  timeout: 3 * 60_000,
  retries: 0, // one request per service, endpoint and origin: no retries
  reporter: [["list"]],
  use: { headless: true },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], browserName: "chromium" } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "webkit", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
