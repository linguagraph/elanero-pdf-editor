import { defineConfig, devices } from '@playwright/test';

// The W8.3 browser performance harness (e2e/perf). It runs the app as it ships: a production build
// served by `vite preview` on the same port as the e2e suite. Chromium only, since the recorded
// metrics are Chromium's (design 2.2, item 5). Tests run one at a time, because each run is a timing.
const APP_PORT = 4174;

export default defineConfig({
  testDir: 'e2e/perf',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results/perf-run',
  timeout: 4 * 60 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_APP_URL ?? `http://localhost:${APP_PORT}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_APP_URL
    ? undefined
    : {
        command: `npx vite build --base=/ --outDir dist/e2e && npx vite preview --outDir dist/e2e --port ${APP_PORT} --strictPort`,
        url: `http://localhost:${APP_PORT}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
