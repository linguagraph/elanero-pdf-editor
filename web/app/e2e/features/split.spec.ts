// W8.1 S4: split a document (W6.2) from the Split command. The dialog previews the parts before
// Split runs, offers them as separate downloads or as one ZIP, and refuses a bad page range without
// running a job. The run is on Chromium (playwright.features.config.ts, project filter).
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, recordHostCheck, watchPage } from './support';

interface Saved {
  name: string;
  bytes: Buffer;
}

// Opens the Split command from the command palette and returns the dialog.
async function openSplit(page: Page): Promise<Locator> {
  await page.getByRole('searchbox', { name: 'Search tools' }).click();
  await page.keyboard.type('Split');
  await page.getByRole('option', { name: 'Split', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Split document' });
  await expect(dialog).toBeVisible();
  return dialog;
}

// Clicks each result download in turn. Each click is paired with its own download event, so no
// wait covers two downloads.
async function saveParts(page: Page, dialog: Locator, count: number): Promise<Saved[]> {
  const links = dialog.getByRole('link', { name: /^Download / });
  await expect(links).toHaveCount(count);
  const saved: Saved[] = [];
  for (let index = 0; index < count; index += 1) {
    const [download] = await Promise.all([page.waitForEvent('download'), links.nth(index).click()]);
    const path = await download.path();
    if (!path) throw new Error(`download failed: ${await download.failure()}`);
    saved.push({ name: download.suggestedFilename(), bytes: readFileSync(path) });
  }
  return saved;
}

// The preview rows read "<name>: <n> pages, from page <first>" (or "1 page, page <first>"). The
// names are the part file names (with .pdf) the split will use, so they are read from the preview.
async function previewRows(dialog: Locator): Promise<{ name: string; pages: number }[]> {
  const texts = await dialog.locator('.split-preview-list li').allTextContents();
  return texts.map((text) => {
    const match = /^(.+?): (\d+) pages?,? (?:from )?page \d+$/.exec(text.trim());
    if (!match) throw new Error(`unexpected preview row: ${text}`);
    return { name: match[1]!, pages: Number(match[2]) };
  });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('every 2 pages: the preview shows 3 files, and each separate download is a part with the right pages', async ({
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openSplit(page);
    await dialog.getByRole('spinbutton', { name: /Pages in each file/ }).fill('2');
    await expect(dialog.locator('.split-preview-summary')).toHaveText('3 files');
    expect(await previewRows(dialog)).toHaveLength(3);

    await dialog.getByRole('radio', { name: 'Separate files', exact: true }).check();
    await dialog.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Files (3)', exact: true })).toBeVisible({
      timeout: 120_000,
    });

    const parts = await saveParts(page, dialog, 3);
    expect(new Set(parts.map((part) => part.name)).size).toBe(3);
    const expected = [
      { pages: 2, first: 'Page 1 heading' },
      { pages: 2, first: 'Page 3 heading' },
      { pages: 1, first: 'Page 5 heading' },
    ];
    for (const [index, part] of parts.entries()) {
      expect(part.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      recordHostCheck(testInfo, 'page_count_pikepdf', part.bytes, {
        pages: expected[index]!.pages,
      });
      recordHostCheck(testInfo, 'text_contains_pdfium', part.bytes, {
        page: 0,
        text: expected[index]!.first,
      });
      recordHostCheck(testInfo, 'pages_nonempty_pdfium', part.bytes);
    }

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('top-level bookmarks: four parts in document order, each with its own file name', async ({
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'outline_unsorted.pdf', fixture('outline_unsorted.pdf'));

    const dialog = await openSplit(page);
    await dialog.getByRole('radio', { name: 'Top-level bookmarks', exact: true }).check();
    await expect(dialog.locator('.split-preview-summary')).toHaveText('4 files');
    const rows = await previewRows(dialog);
    // Document order, not alphabetical: Intro, Zebra, then the two Appendix parts.
    expect(rows.map((row) => row.name.toLowerCase())).toEqual([
      expect.stringContaining('intro'),
      expect.stringContaining('zebra'),
      expect.stringContaining('appendix'),
      expect.stringContaining('appendix'),
    ]);
    expect(new Set(rows.map((row) => row.name)).size).toBe(4);

    await dialog.getByRole('radio', { name: 'Separate files', exact: true }).check();
    await dialog.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Files (4)', exact: true })).toBeVisible({
      timeout: 120_000,
    });

    const parts = await saveParts(page, dialog, 4);
    expect(new Set(parts.map((part) => part.name)).size).toBe(4);
    for (const part of parts) {
      recordHostCheck(testInfo, 'page_count_pikepdf', part.bytes, { pages: 1 });
    }

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('one ZIP file: a single .zip download whose three parts open in pikepdf and pypdfium2', async ({
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openSplit(page);
    await dialog.getByRole('spinbutton', { name: /Pages in each file/ }).fill('2');
    await expect(dialog.locator('.split-preview-summary')).toHaveText('3 files');
    const rows = await previewRows(dialog);

    await dialog.getByRole('radio', { name: 'One ZIP file', exact: true }).check();
    await dialog.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Files (1)', exact: true })).toBeVisible({
      timeout: 120_000,
    });

    const [zip] = await saveParts(page, dialog, 1);
    expect(zip!.name).toMatch(/\.zip$/);
    expect(zip!.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    // The ZIP holds the parts under the preview's names, in order, with the preview's page counts.
    recordHostCheck(testInfo, 'zip_parts_pdf', zip!.bytes, {
      names: rows.map((row) => row.name),
      pages: rows.map((row) => row.pages),
    });

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('an out-of-range page range shows the error and runs no split', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const dialog = await openSplit(page);
    await dialog.getByRole('radio', { name: 'Page ranges', exact: true }).check();
    await dialog.getByRole('textbox', { name: /^Page ranges/ }).fill('9');
    await dialog.getByRole('button', { name: 'Split', exact: true }).click();

    await expect(dialog.getByRole('alert')).toHaveText(
      '"9" is outside the document, which has 5 pages.',
    );
    // No job ran: no results heading and no download link.
    await expect(dialog.getByRole('heading', { name: /^Files \(/ })).toHaveCount(0);
    await expect(dialog.getByRole('link', { name: /^Download / })).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(problems).toEqual([]);
  });
});
