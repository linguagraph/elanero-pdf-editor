import { defineConfig, devices } from '@playwright/test';

// The W4.3b key probe (e2e/keys.spec.ts). It is kept out of the default run (playwright.config.ts
// ignores it) because it is a manual measurement, not a gate: it runs the three engines and reports
// what each browser does with the reserved and second-group keys. Run it with
// `npx playwright test -c playwright.keys.config.ts`, or through the manual web-keys.yml workflow.
// It serves the production build on its own port, as the main config does for the app.
const APP_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'keys.spec.ts',
  timeout: 10 * 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // The same build step as playwright.config.ts: the root base, in dist/e2e.
    command: `npx vite build --base=/ --outDir dist/e2e && npx vite preview --outDir dist/e2e --port ${APP_PORT} --strictPort`,
    url: `http://localhost:${APP_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
