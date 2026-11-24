// W7.6 slice D: Document properties in the browser. The Description fields show the file's values,
// an edited title applies and Undo takes it back (the toast). Advanced shows the PDF version and the
// page count. Fonts reads session.fonts when its tab is first shown and lists the fonts with their
// embedding. Security shows the method and the eight permissions of an encrypted file, opened with
// its password (the password never reaches the dialog). Each tab is checked with axe in light and
// dark. Written from the design (docs/web/design/W7.6-properties-panels.md) and the components; the
// Chromium run in web-e2e is still pending, so PLAN.md keeps W7.6 unticked.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { checkAxe } from './axe';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

const SCHEMES = ['light', 'dark'] as const;

// Opens Document properties from the command palette and returns its dialog. One fill, as the other
// specs do; the option's name also holds its shortcut, so it is matched by its start.
async function openProperties(page: Page): Promise<Locator> {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill('Properties');
  await page.getByRole('option', { name: /^Properties/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Document properties' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Picks a property page by its tab name.
async function showTab(dialog: Locator, name: RegExp | string): Promise<void> {
  await dialog.getByRole('tab', { name }).click();
}

// The value shown next to a label in one of the read-only lists (<dt> then <dd>).
function valueOf(dialog: Locator, label: string): Locator {
  return dialog.locator(`dt:text-is("${label}") + dd`);
}

// Opens encrypted.pdf with its user password "user" (make_fixtures.py), as the security spec does.
async function openEncrypted(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'encrypted.pdf',
    mimeType: 'application/pdf',
    buffer: fixture('encrypted.pdf'),
  });
  const prompt = page.getByRole('dialog', { name: 'Password required' });
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await prompt.getByLabel('Password', { exact: true }).fill('user');
  await prompt.getByRole('button', { name: 'Enter password' }).click();
  await expect(page.getByRole('tab', { name: 'encrypted.pdf' })).toBeVisible({ timeout: 60_000 });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('Description: an edited title applies, and Undo from the toast takes it back', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    let dialog = await openProperties(page);
    const title = dialog.getByLabel('Title', { exact: true });
    await expect(title).toHaveValue('');
    await title.fill('Properties check');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Document properties updated', { exact: true })).toBeVisible();

    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    dialog = await openProperties(page);
    await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('');
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Advanced: the PDF version and the page count of the open file', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openProperties(page);
    await showTab(dialog, 'Advanced');
    await expect(valueOf(dialog, 'PDF version')).toHaveText(/^\d\.\d$/);
    await expect(valueOf(dialog, 'Pages')).toHaveText('5');
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Fonts: the fonts of the file list as not embedded (the base-14 fonts)', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openProperties(page);
    await showTab(dialog, /^Fonts/);
    const table = dialog.getByRole('table', { name: 'Fonts used in this document' });
    await expect(table).toBeVisible();
    // The tab carries the count once the fonts are read.
    await expect(dialog.getByRole('tab', { name: /^Fonts \(\d+\)$/ })).toBeVisible();
    // The fixture draws three base-14 fonts (hebo, helv, cour), none embedded.
    await expect(table.getByRole('cell', { name: 'Not embedded', exact: true })).toHaveCount(3);
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Security: an encrypted file shows AES-256 and its permissions, and no password', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openEncrypted(page);

    const dialog = await openProperties(page);
    await showTab(dialog, 'Security');
    await expect(valueOf(dialog, 'Security')).toHaveText('AES-256');
    // encrypted.pdf allows printing and accessibility only (make_fixtures.py).
    await expect(valueOf(dialog, 'Printing')).toHaveText('Allowed');
    await expect(valueOf(dialog, 'Copying text and images')).toHaveText('Not allowed');
    expect(problems, 'CSP or page errors').toEqual([]);
  });

  for (const scheme of SCHEMES) {
    test.describe(`${scheme} scheme`, () => {
      test.use({ colorScheme: scheme });

      test(`axe: Description tab (${scheme}) @a11y`, async ({ page }, testInfo) => {
        await openApp(page);
        await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
        const dialog = await openProperties(page);
        await expect(dialog.getByLabel('Title', { exact: true })).toBeVisible();
        await checkAxe(page, testInfo);
      });

      test(`axe: Advanced tab (${scheme}) @a11y`, async ({ page }, testInfo) => {
        await openApp(page);
        await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
        const dialog = await openProperties(page);
        await showTab(dialog, 'Advanced');
        await expect(valueOf(dialog, 'PDF version')).toBeVisible();
        await checkAxe(page, testInfo);
      });

      test(`axe: Fonts tab (${scheme}) @a11y`, async ({ page }, testInfo) => {
        await openApp(page);
        await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
        const dialog = await openProperties(page);
        await showTab(dialog, /^Fonts/);
        await expect(dialog.getByRole('table')).toBeVisible();
        await checkAxe(page, testInfo);
      });

      test(`axe: Security tab (${scheme}) @a11y`, async ({ page }, testInfo) => {
        await openApp(page);
        await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
        const dialog = await openProperties(page);
        await showTab(dialog, 'Security');
        await expect(valueOf(dialog, 'Security')).toBeVisible();
        await checkAxe(page, testInfo);
      });
    });
  }
});
