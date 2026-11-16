// W0.1 spike (spike-only). Serves web/spike from a local static server; nothing is fetched from a
// CDN. Chromium only, as the spike decision needs one browser.
import { defineConfig } from "@playwright/test";

const PORT = 8765;

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  outputDir: "out/test-results",
  timeout: 12 * 60_000,
  reporter: [["list"], ["junit", { outputFile: "out/smoke-junit.xml" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `npx http-server . -p ${PORT} -s -c-1`,
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/smoke/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
