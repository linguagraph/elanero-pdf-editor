// W8.1 (issue 772, slice R2): Replace pages from the ribbon's Replace command. The dialog takes a PDF
// (the source), names its pages (a range that may bring more or fewer pages than the selection), and
// replaces the selected pages in one change. The run is on Chromium (npm run e2e:features:chromium).
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// Opens the Replace command from the command palette and returns its dialog. The option's name
// also holds its tab and shortcut, so it is matched by its start, and Replace Image is skipped.
async function openReplace(page: Page): Promise<Locator> {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill('Replace');
  await page.getByRole('option', { name: /^Replace(?! Image)/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace pages' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Chooses the source PDF through the dialog's own Choose file input, then waits for its count.
async function chooseSource(dialog: Locator, name: string, buffer: Buffer): Promise<void> {
  await dialog.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer,
  });
  await expect(dialog.locator('.replace-file')).toContainText('5 pages');
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('replace page 1 with pages 4-5 of another file: the saved file has six pages, in order', async ({
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openReplace(page);
    await chooseSource(dialog, 'source.pdf', fixture('text_multipage.pdf'));
    const range = dialog.getByRole('textbox', { name: 'Source pages' });
    await range.fill('4-5');
    await expect(dialog.getByRole('status')).toHaveText('Replace 1 page with 2 pages.');
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 120_000 });

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    recordHostCheck(testInfo, 'page_count_pikepdf', saved.bytes, { pages: 6 });
    recordHostCheck(testInfo, 'text_contains_pdfium', saved.bytes, {
      page: 0,
      text: 'Page 4 heading',
    });
    recordHostCheck(testInfo, 'text_contains_pdfium', saved.bytes, {
      page: 1,
      text: 'Page 5 heading',
    });
    recordHostCheck(testInfo, 'text_contains_pdfium', saved.bytes, {
      page: 2,
      text: 'Page 2 heading',
    });
    expect(problems).toEqual([]);
  });

  test('a source page past the file is refused in the dialog, which stays open', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openReplace(page);
    await chooseSource(dialog, 'source.pdf', fixture('text_multipage.pdf'));
    await dialog.getByRole('textbox', { name: 'Source pages' }).fill('9');
    await expect(dialog.getByRole('alert')).toContainText('from 1 to 5');
    await expect(dialog.getByRole('button', { name: 'Replace', exact: true })).toBeDisabled();
    await expect(dialog).toBeVisible();
    expect(problems).toEqual([]);
  });
});
