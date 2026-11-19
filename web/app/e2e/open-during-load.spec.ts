// W3.1 browser check of the open queue: a PDF picked while the engine is still loading waits on the
// start page ("Waiting to open"), and opens once the engine is ready. The wheel request is held back
// for a few seconds, so the load is certainly still running when the file is picked; without the
// delay a cached load can finish first, and the check would prove nothing (plan risk 6).
// It runs against the production build (vite preview, as in playwright.config.ts) and skips the
// same way as app-start.spec.ts when the engine assets are not staged.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

const WHEEL = /\/pymupdf-[^/]+\.whl$/;
const WHEEL_DELAY_MS = 3_000;

// A one-page PDF, as in app-start.spec.ts.
function pdf(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
      'trailer << /Root 1 0 R >>\n%%EOF\n',
  );
}

// Holds the engine's wheel request for a while, then lets it through.
async function delayWheel(page: Page): Promise<void> {
  await page.route(WHEEL, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, WHEEL_DELAY_MS));
    await route.continue();
  });
}

function pick(page: Page, name: string): Promise<void> {
  return page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: pdf(),
  });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a PDF picked while the engine loads shows "Waiting to open", then opens when ready', async ({
    page,
  }) => {
    await delayWheel(page);
    await page.goto('/');
    await expect(page.locator('.loading-screen')).toBeVisible();

    await pick(page, 'tiny.pdf');
    await expect(page.locator('.start-pending')).toContainText('Waiting to open');
    await expect(page.locator('.start-pending')).toContainText('tiny.pdf');
    await expect(page.getByRole('tab', { name: /tiny\.pdf/ })).toHaveCount(0);

    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await expect(page.getByRole('tab', { name: /tiny\.pdf/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.start-pending')).toHaveCount(0);
  });

  test('of two PDFs picked during the load, "Don\'t open" drops one and the other opens', async ({
    page,
  }) => {
    await delayWheel(page);
    await page.goto('/');
    await expect(page.locator('.loading-screen')).toBeVisible();

    await pick(page, 'first.pdf');
    await pick(page, 'second.pdf');
    await expect(page.locator('.start-pending-list li')).toHaveCount(2);
    await page.getByRole('button', { name: "Don't open first.pdf" }).click();
    await expect(page.locator('.start-pending-list li')).toHaveCount(1);

    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });
    await expect(page.getByRole('tab', { name: /second\.pdf/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('tab', { name: /first\.pdf/ })).toHaveCount(0);
    await expect(page.locator('.start-pending')).toHaveCount(0);
  });
});

test.describe('engine assets not staged', () => {
  test.skip(STAGED, 'engine assets are staged, so the load succeeds; this check does not apply');

  test('a PDF picked while the load fails stays in the queue, and the failure shows Try again', async ({
    page,
  }) => {
    await page.goto('/');
    await pick(page, 'tiny.pdf');
    await expect(page.locator('.start-pending')).toContainText('tiny.pdf');
    await expect(page.getByRole('heading', { name: 'Elanero could not start' })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The failed load keeps the queued file (plan decision 4): it is still waiting, and no tab opens.
    await expect(page.locator('.start-pending')).toContainText('tiny.pdf');
    await expect(page.getByRole('tab', { name: /tiny\.pdf/ })).toHaveCount(0);
  });
});
