// W8.5 S3: axe on the start page and the dialogs that open with no document, in light and dark.
// The start page and its ribbon render while the engine loads, so these screens need no engine and
// run on every features browser. Dialogs that need a document or an engine session (Save As,
// Print, Export, and the rest) are S5's, once the engine is staged in the workflow.
import { expect, test, type Page } from '@playwright/test';
import { openPreferences } from '../harness/openPreferences';
import { checkAxe } from './axe';
import { STAGED, fixture, openApp, openPdf } from './support';

const SCHEMES = ['light', 'dark'] as const;

async function openStartPage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.start-page')).toBeVisible();
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test(`axe: start page (${scheme}) @a11y`, async ({ page }, testInfo) => {
      await openStartPage(page);
      await checkAxe(page, testInfo);
    });

    test(`axe: Preferences dialog (${scheme}) @a11y`, async ({ page }, testInfo) => {
      await openStartPage(page);
      await openPreferences(page);
      await checkAxe(page, testInfo);
    });

    test(`axe: Keyboard Shortcuts dialog (${scheme}) @a11y`, async ({ page }, testInfo) => {
      await openStartPage(page);
      await openPreferences(page);
      await page.getByRole('button', { name: 'Keyboard Shortcuts…', exact: true }).click();
      await expect(page.getByRole('dialog').last()).toBeVisible();
      await checkAxe(page, testInfo);
    });

    test(`axe: command palette (${scheme}) @a11y`, async ({ page }, testInfo) => {
      await openStartPage(page);
      // Typing in the ribbon's search box opens the palette with that text as its query.
      await page.getByRole('searchbox', { name: 'Search tools' }).click();
      await page.keyboard.type('a');
      await expect(page.getByRole('dialog').first()).toBeVisible();
      await checkAxe(page, testInfo);
    });
  });
}

// The marks dialogs (W7.3 S3) need a document, so they run once the engine is staged.
test.describe('engine staged', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  for (const [button, title] of [
    ['Header & Footer', 'Header & Footer'],
    ['Background', 'Background'],
  ] as const) {
    test(`axe: ${title} dialog @a11y`, async ({ page }, testInfo) => {
      await openApp(page);
      await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
      await page.locator('.ribbon [role="tab"]', { hasText: 'Organize' }).click();
      await page.getByRole('button', { name: button, exact: true }).click();
      await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible();
      await checkAxe(page, testInfo);
    });
  }
});
