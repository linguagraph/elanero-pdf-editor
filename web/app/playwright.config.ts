import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite (W8.1) is not run by this scaffold; the config only has to typecheck.
// The base URL comes from the environment so CI can point it at the static server.
export default defineConfig({
  testDir: 'e2e',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
