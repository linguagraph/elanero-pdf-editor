// Issue 757: a recent file shows its first page as a small preview on the start page. The preview
// is drawn once the browser is idle after the file opens, and kept in the browser's private storage
// on this device. The spec opens a one-page PDF through a faked picker (as open-recent.spec.ts does),
// closes its tab, and waits for the recent row's image to decode. Then it reloads and checks the
// image is still there. It runs against the staged engine, so it skips when the engine assets are
// missing. Not run in the change that added it: Playwright cannot run in that environment.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

// A one-page PDF, as in open-recent.spec.ts.
const PDF_TEXT =
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
  'trailer << /Root 1 0 R >>\n%%EOF\n';

// Replaces window.showOpenFilePicker with a fake that returns one file handle for recent.pdf.
async function fakePicker(page: Page): Promise<void> {
  await page.addInitScript((text: string) => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: () => {
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

// The decoded width of the recent row's preview, 0 while it is missing or still loading.
async function previewWidth(page: Page): Promise<number> {
  return page
    .locator('.start-recent-list img')
    .evaluate((img: HTMLImageElement) => img.naturalWidth)
    .catch(() => 0);
}

// The number of preview files in the browser's private storage. The preview is saved in the
// background after the file opens, and the start page (where previewWidth reads it) is hidden
// while the file is open, so the save is waited for through the storage instead.
async function savedPreviewCount(page: Page): Promise<number> {
  return page
    .evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('recent-thumbs');
        const names = (dir as unknown as { keys(): AsyncIterable<string> }).keys();
        let count = 0;
        for await (const name of names) {
          if (name.endsWith('.jpg')) count += 1;
        }
        return count;
      } catch {
        return 0;
      }
    })
    .catch(() => 0);
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a recent file keeps its first-page preview across a reload', async ({ page }) => {
    await fakePicker(page);
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Elanero');
    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await page.getByRole('button', { name: 'Open file' }).click();
    await expect(page.locator('.doc-tab')).toContainText('recent.pdf', { timeout: 60_000 });
    // The preview is saved once the browser is idle after the file opens. Wait for that save while
    // the file is still open, before the tab closes.
    await expect.poll(() => savedPreviewCount(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // Back to the start page: the row shows the preview once it has been drawn and decoded.
    await page.locator('[role="tab"] .doc-tab-close').first().click();
    await expect(page.locator('.start-recent-name', { hasText: 'recent.pdf' })).toBeVisible();
    await expect.poll(() => previewWidth(page), { timeout: 15_000 }).toBeGreaterThan(0);

    // A reload reads the preview back from private storage.
    await page.reload();
    await expect(page.locator('.start-recent-name', { hasText: 'recent.pdf' })).toBeVisible();
    await expect.poll(() => previewWidth(page), { timeout: 15_000 }).toBeGreaterThan(0);
  });
});
