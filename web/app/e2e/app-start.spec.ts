// W3.1 browser check of the app itself: the start-up screen follows the engine's stages, and a PDF
// opens through session.open. It runs against the production build (vite preview, as in
// playwright.config.ts), so the strict CSP and the built worker URL are the real ones.
//
// The engine needs the staged assets (scripts/stage_engine_assets.mjs writes them to
// public/engine-assets/, which is git-ignored). Without them the ready check cannot run, so that
// check is skipped with the reason shown, and the failure check runs instead.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

// A one-page PDF. The engine opens it as a real document, so the tab's name is the proof.
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
    'trailer << /Root 1 0 R >>\n%%EOF\n',
);

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('the loading screen reaches ready, and a PDF opens through session.open', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.loading-screen')).toBeHidden({ timeout: 180_000 });

    await page.locator('input[type="file"]').setInputFiles({
      name: 'tiny.pdf',
      mimeType: 'application/pdf',
      buffer: PDF,
    });
    await expect(page.getByRole('tab', { name: /tiny\.pdf/ })).toBeVisible({ timeout: 60_000 });
  });
});

test.describe('engine assets not staged', () => {
  test.skip(STAGED, 'engine assets are staged, so the load succeeds; this check does not apply');

  test('a failed load shows the failure and Try again, without hanging', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Elanero could not start' })).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
