import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite runs the engine in a real browser (W3.1). The page it opens is a test-only
// harness (e2e/harness) served by its own Vite config, so the production build never has it.
// The base URL comes from the environment so CI can point it at another server. Only Chromium
// runs for now; Firefox and WebKit come with the wider suite (W8.1).
const PORT = 4173;
// The app as it ships (W4.2a layout checks): a production build served by `vite preview`, so the
// strict CSP applies to the real stylesheet link. The dev harness injects its CSS inline, which
// that policy blocks, so the layout spec cannot use it.
const APP_PORT = 4174;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  // The key probe has its own config (playwright.keys.config.ts) and a manual workflow (W4.3b). The
  // feature round trips run on three browsers under playwright.features.config.ts (W8.1).
  testIgnore: ['keys.spec.ts', 'features/**', 'perf/**'],
  timeout: 5 * 60_000,
  // Screenshot references (W8.2 S4, visual-ui.spec.ts) live with the desktop UI goldens, one folder
  // per platform. They change only through a web-e2e dispatch with update_snapshots=true (D6): the
  // spec fails on a missing reference and names that command, and updateSnapshots stays 'none' here.
  snapshotPathTemplate: '../../tests/golden/web/linux/{arg}{ext}',
  updateSnapshots: 'none',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: `npx vite --config e2e/harness/vite.config.ts --port ${PORT} --strictPort`,
          url: `http://localhost:${PORT}/e2e/harness/index.html`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
        {
          // The e2e build takes the root base (`vite preview` serves the folder at the root; the
          // production base of W9.2 would put every asset under a sub-path it does not serve). It
          // goes to dist/e2e, so it never overwrites the production build in dist/.
          command: `npx vite build --base=/ --outDir dist/e2e && npx vite preview --outDir dist/e2e --port ${APP_PORT} --strictPort`,
          url: `http://localhost:${APP_PORT}/`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      ],
});
