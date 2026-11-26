// Issue 756: on Chromium a recent file reopens from its saved File System Access handle with no
// file chooser. The picker is faked before the page scripts run (init scripts run outside the page
// CSP, as in file-launch.spec.ts): the first Open returns one handle for recent.pdf, and the spec
// counts the picker calls. Opening it saves the handle; after the tab closes, the recent row's
// click must reopen the file with no picker call and no file-chooser event. Other browsers keep the
// picker (the browser limit), which this spec does not cover. It runs against the staged engine, so
// it skips when the engine assets are missing, as open-during-load.spec.ts does.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

// A one-page PDF, as in file-launch.spec.ts.
const PDF_TEXT =
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
  'trailer << /Root 1 0 R >>\n%%EOF\n';

// Replaces window.showOpenFilePicker with a fake that returns one file handle and counts calls.
async function fakePicker(page: Page): Promise<void> {
  await page.addInitScript((text: string) => {
    const state = { calls: 0 };
    Object.defineProperty(window, '__picker', { configurable: true, value: state });
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () => {
        state.calls += 1;
        const handle = {
          kind: 'file',
          name: 'recent.pdf',
          getFile: () =>
            Promise.resolve(new File([text], 'recent.pdf', { type: 'application/pdf' })),
          requestPermission: () => Promise.resolve('granted'),
        };
        return Promise.resolve([handle]);
      },
    });
  }, PDF_TEXT);
}

async function pickerCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __picker: { calls: number } }).__picker.calls);
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a recent file reopens from its saved handle with no file chooser', async ({ page }) => {
    await fakePicker(page);
    let choosers = 0;
    page.on('filechooser', () => {
      choosers += 1;
    });

    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Elanero');
    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await page.getByRole('button', { name: 'Open file' }).click();
    await expect(page.locator('.doc-tab')).toContainText('recent.pdf', { timeout: 60_000 });
    expect(await pickerCalls(page)).toBe(1);

    // Back to the start page: the tab closes, the recent row lists the file.
    await page.locator('[role="tab"] .doc-tab-close').first().click();
    const row = page.locator('.start-recent-name', { hasText: 'recent.pdf' });
    await expect(row).toBeVisible();

    await row.click();
    await expect(page.locator('.doc-tab')).toContainText('recent.pdf');
    expect(await pickerCalls(page)).toBe(1);
    expect(choosers).toBe(0);
  });
});
