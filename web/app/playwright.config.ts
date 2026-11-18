import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite runs the engine in a real browser (W3.1). The page it opens is a test-only
// harness (e2e/harness) served by its own Vite config, so the production build never has it.
// The base URL comes from the environment so CI can point it at another server. Only Chromium
// runs for now; Firefox and WebKit come with the wider suite (W8.1).
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  timeout: 5 * 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx vite --config e2e/harness/vite.config.ts --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/e2e/harness/index.html`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
