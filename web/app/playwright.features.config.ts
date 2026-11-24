import { defineConfig, devices } from '@playwright/test';

// The W8.1 feature round trips (e2e/features): each flow runs in the production build, under the
// strict CSP and the service worker, on Chromium, Firefox and WebKit (Safari's engine). The main
// config (playwright.config.ts) runs only the harness and app-level specs, and ignores this folder.
// Run it with `npm run e2e:features` after the engine assets are staged (AGENTS.md).
// Its own port: the other configs use 4174, and reuseExistingServer would otherwise test a build
// another checkout is serving there.
const APP_PORT = 4175;

export default defineConfig({
  testDir: 'e2e/features',
  testMatch: '**/*.spec.ts',
  timeout: 5 * 60_000,
  // Four workers in CI, one locally. Each parallel slot writes its own host-checks-<n>.json (see
  // e2e/features/support.ts), so workers do not lose each other's entries.
  workers: process.env.CI ? 4 : 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    // The root base, in dist/e2e, as the other configs do (dist/ holds the production build).
    command: `npx vite build --base=/ --outDir dist/e2e && npx vite preview --outDir dist/e2e --port ${APP_PORT} --strictPort`,
    url: `http://localhost:${APP_PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
