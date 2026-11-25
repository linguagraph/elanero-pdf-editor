// W8.1 S5: Save and Save As (W4.8, W4.9). Save downloads the document under its own name, so the
// file the user gets is the file the tab shows. Save As asks for a new name, downloads a full copy
// under it, and renames the tab to that name. Each saved file is checked outside the browser (pikepdf
// opens it, pdfium counts its pages, and the crop made before the save is in its CropBox).
import { readFileSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import {
  STAGED,
  cropAllPages,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// The main menu's Save As… item (the File group of the app menu).
async function chooseSaveAs(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.locator('.app-menu-item', { hasText: 'Save As…' }).click();
}

// The crop the saved files must carry: 36 pt off every side of an A4 page (595 x 842 pt).
const CROPPED_W = 595 - 72;
const CROPPED_H = 842 - 72;

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('save writes the document back under its own name', async ({
    browserName,
    page,
    context,
  }, testInfo) => {
    test.fixme(
      browserName === 'webkit',
      'WebKit: the style-src CSP refuses a stylesheet (console message), so the CSP check fails there; tracked in #420',
    );
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await cropAllPages(page, 36, 5);

    const saved = await saveDownload(page);
    expect(saved.name).toBe('text_multipage.pdf');
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // The tab keeps its name: Save does not rename the document.
    await expect(page.getByRole('tab', { name: 'text_multipage.pdf' })).toBeVisible();

    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();

    recordHostCheck(testInfo, 'opens_pikepdf', saved.bytes);
    recordHostCheck(testInfo, 'page_count_pdfium', saved.bytes, { pages: 5 });
    recordHostCheck(testInfo, 'crop_box_size_pikepdf', saved.bytes, {
      width: CROPPED_W,
      height: CROPPED_H,
      page: 0,
    });
    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });

  test('save as writes a new name and renames the tab', async ({ browserName, page }, testInfo) => {
    test.fixme(
      browserName === 'webkit',
      'WebKit: the style-src CSP refuses a stylesheet (console message), so the CSP check fails there; tracked in #420',
    );
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await cropAllPages(page, 36, 5);

    await chooseSaveAs(page);
    const dialog = page.getByRole('dialog', { name: 'Save As' });
    await expect(dialog).toBeVisible();
    // The name field opens with the tab's name; typing replaces the name (the .pdf is added back).
    const input = dialog.getByRole('textbox', { name: 'File name' });
    await expect(input).toHaveValue('text_multipage.pdf');
    await input.fill('renamed-copy');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Save As', exact: true }).click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error(`download failed: ${await download.failure()}`);
    const saved = { name: download.suggestedFilename(), bytes: readFileSync(path) };
    expect(saved.name).toBe('renamed-copy.pdf');
    await expect(dialog).toBeHidden();

    // The tab takes the new name; the old one is gone.
    await expect(page.getByRole('tab', { name: 'renamed-copy.pdf' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'text_multipage.pdf' })).toHaveCount(0);

    recordHostCheck(testInfo, 'opens_pikepdf', saved.bytes);
    recordHostCheck(testInfo, 'page_count_pdfium', saved.bytes, { pages: 5 });
    recordHostCheck(testInfo, 'crop_box_size_pikepdf', saved.bytes, {
      width: CROPPED_W,
      height: CROPPED_H,
      page: 0,
    });
    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
