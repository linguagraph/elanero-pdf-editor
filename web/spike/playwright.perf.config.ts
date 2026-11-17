// W0.2 perf run (spike-only). Chromium always; Firefox and WebKit only when PERF_BROWSERS asks
// for them (the laptop run). Tests run one at a time: each writes a shared JSON file.
import { defineConfig } from "@playwright/test";

const PORT = 8766;
const browsers = (process.env.PERF_BROWSERS ?? "chromium").split(",");

export default defineConfig({
  testDir: ".",
  testMatch: "perf.spec.ts",
  outputDir: "out/perf-test-results",
  timeout: 90 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
  },
  projects: browsers.map((name) => ({ name, use: { browserName: name as "chromium" } })),
  webServer: {
    command: `node perf/server.mjs ${PORT}`,
    cwd: __dirname,
    url: `http://127.0.0.1:${PORT}/perf/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
