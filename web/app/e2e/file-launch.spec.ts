// W4.6 S1 browser check: a PDF the OS hands to the app (File Handling API, `launchQueue`) opens
// through the same queue as the Open button. Chromium gives no way to trigger a real OS launch from
// automation, so the spec replaces `window.launchQueue` with a fake before the page scripts run
// (init scripts run outside the page CSP). The fake keeps the consumer the app sets, and the test
// calls it with a launch, as the browser would. It runs against the production build (vite preview,
// as in pwa.spec.ts) and the staged check skips the same way as open-during-load.spec.ts.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

// A one-page PDF, as in open-during-load.spec.ts.
const PDF_TEXT =
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
  'trailer << /Root 1 0 R >>\n%%EOF\n';

// Replaces window.launchQueue with a fake that keeps the consumer the app sets. Runs before the
// page's own scripts, so the app finds the fake when main.tsx calls installLaunchInbox.
async function fakeLaunchQueue(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let consumer: ((params: unknown) => void) | null = null;
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: {
        setConsumer(next: (params: unknown) => void) {
          consumer = next;
        },
      },
    });
    Object.defineProperty(window, '__launch', {
      configurable: true,
      value: (files: { name: string; text: string; type: string }[]) => {
        consumer?.({
          files: files.map((file) => ({
            kind: 'file',
            name: file.name,
            getFile: () => Promise.resolve(new File([file.text], file.name, { type: file.type })),
          })),
        });
      },
    });
  });
}

// The browser hands the launch to the consumer; the fake's `__launch` plays that role.
async function launch(
  page: Page,
  files: { name: string; text: string; type: string }[],
): Promise<void> {
  await page.evaluate((list) => {
    (window as unknown as { __launch(files: unknown[]): void }).__launch(list);
  }, files);
}

test('records whether Chromium exposes launchQueue on a plain page (risk R4)', async ({
  page,
}, testInfo) => {
  await page.goto('about:blank');
  const exposed = await page.evaluate(() => 'launchQueue' in window);
  testInfo.annotations.push({
    type: 'launchQueue exposed by Chromium',
    description: String(exposed),
  });
});

test('a launched PDF reaches the open queue while the engine loads, under "Waiting to open"', async ({
  page,
}) => {
  await fakeLaunchQueue(page);
  await page.goto('/');
  await expect(page.locator('.loading-screen')).toBeVisible();

  await launch(page, [{ name: 'launched.pdf', text: PDF_TEXT, type: 'application/pdf' }]);
  await expect(page.locator('.start-pending')).toContainText('Waiting to open');
  await expect(page.locator('.start-pending')).toContainText('launched.pdf');
});

test('a launched .txt file gets the not-a-PDF message and opens no tab', async ({ page }) => {
  await fakeLaunchQueue(page);
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText('Elanero');

  await launch(page, [{ name: 'notes.txt', text: 'hello', type: 'text/plain' }]);
  await expect(
    page.getByText('notes.txt is not a PDF. Choose a file whose name ends in .pdf.'),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: /notes\.txt/ })).toHaveCount(0);
});

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a launched PDF opens in a tab once the engine is ready', async ({ page }) => {
    await fakeLaunchQueue(page);
    await page.goto('/');
    await launch(page, [{ name: 'launched.pdf', text: PDF_TEXT, type: 'application/pdf' }]);
    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await expect(page.getByRole('tab', { name: /launched\.pdf/ })).toBeVisible({ timeout: 60_000 });
  });
});
