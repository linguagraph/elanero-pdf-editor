// W8.1 S6: reduce file size with the space audit (W6.4). The compress dialog runs one reduce_size job
// that also measures the space by part before and after; the result shows the table next to the
// sizes. The flow: reduce heavy.pdf (the fixture made to be compressed) with Smallest, check the
// table and the download; then reopen the reduced copy and run Lossless on it, which does not make
// it smaller, so the table shows with no download. The run is on all three browsers
// (playwright.features.config.ts).
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { recordHostCheck, STAGED, fixture, openApp, openPdf, watchPage } from './support';

// Opens the command palette from the ribbon's search box and runs Reduce File Size. One fill, not
// typed keys: the first key opens the palette, and the rest would have to reach its input in time.
// The option's accessible name also holds its tab and shortcut, so it is matched by its start.
async function openReduceFileSize(page: Page) {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill('Reduce File Size');
  await page.getByRole('option', { name: /^Reduce File Size/ }).click();
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('reduce a file: the space table shows and the download is smaller', async ({
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    const original = fixture('heavy.pdf');
    await openApp(page);
    await openPdf(page, 'heavy.pdf', original);

    await openReduceFileSize(page);
    const dialog = page.getByRole('dialog', { name: 'Reduce file size' });
    await expect(dialog).toBeVisible();

    // Smallest, then Compress: one job, and the result has the sizes and the space table.
    // The radio input is visually hidden inside its label, which takes the click: click the label.
    await dialog.getByText('Smallest (screen)', { exact: true }).click();
    await expect(
      dialog.getByRole('radio', { name: 'Smallest (screen)', exact: true }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Compress', exact: true }).click();
    const table = dialog.getByRole('table');
    await expect(table).toBeVisible({ timeout: 120_000 });
    await expect(table.locator('caption')).toHaveText('Space by part (Smallest (screen))');
    await expect(table.getByRole('row', { name: /Images/ })).toContainText('less');

    // The download is the reduced copy, and it is smaller than the original.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('link', { name: /^Download / }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('reduced.pdf');
    const path = await download.path();
    if (!path) throw new Error(`download failed: ${await download.failure()}`);
    const reduced = readFileSync(path);
    expect(reduced.byteLength).toBeLessThan(original.byteLength);
    // The reduced copy is one page, and it must open in pikepdf and render in pypdfium2.
    recordHostCheck(testInfo, 'page_count_pikepdf', reduced, { pages: 1 });
    recordHostCheck(testInfo, 'render_pdfium', reduced, { page: 0, scale: 1 });

    expect(problems).toEqual([]);
  });

  test('not-smaller case: a reduced copy run with Lossless shows the table with no download', async ({
    page,
  }) => {
    // Issue #610: the web reduce job compares with the wrong baseline (a re-save, not the opened
    // file), so the not-smaller result below is not reached yet. See
    // docs/web/design/W6.4-compress-spec-decision.md section 4. Remove this fixme with that fix.
    test.fixme(true, 'issue #610: the web reduce job compares with the wrong baseline');
    const problems = watchPage(page);
    const original = fixture('heavy.pdf');
    await openApp(page);
    await openPdf(page, 'heavy.pdf', original);

    // Make the reduced copy first: Smallest, then Compress, then download it.
    await openReduceFileSize(page);
    const dialog = page.getByRole('dialog', { name: 'Reduce file size' });
    await expect(dialog).toBeVisible();
    await dialog.getByText('Smallest (screen)', { exact: true }).click();
    await expect(
      dialog.getByRole('radio', { name: 'Smallest (screen)', exact: true }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Compress', exact: true }).click();
    await expect(dialog.getByRole('table')).toBeVisible({ timeout: 120_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('link', { name: /^Download / }).click(),
    ]);
    const path = await download.path();
    if (!path) throw new Error(`download failed: ${await download.failure()}`);
    const reduced = readFileSync(path);

    // Reopen the reduced copy and run Lossless on it: the copy is not smaller, so the message
    // says so, the table still shows, and there is no download.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await openPdf(page, 'reduced.pdf', reduced);
    await openReduceFileSize(page);
    const again = page.getByRole('dialog', { name: 'Reduce file size' });
    await again.getByText('Lossless', { exact: true }).click();
    await expect(again.getByRole('radio', { name: 'Lossless', exact: true })).toBeChecked();
    await again.getByRole('button', { name: 'Compress', exact: true }).click();
    await expect(again.getByRole('status')).toContainText('do not make the file smaller', {
      timeout: 120_000,
    });
    await expect(again.getByRole('table')).toBeVisible();
    await expect(again.getByRole('link', { name: /^Download / })).toHaveCount(0);

    expect(problems).toEqual([]);
  });
});
