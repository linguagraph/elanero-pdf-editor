// W8.1 S6: reduce file size with the space audit (W6.4). The compress dialog runs one reduce_size job
// that also measures the space by part before and after; the result shows the table next to the
// sizes. The flow: reduce images.pdf with Smallest, check the table and the download; then reopen the
// reduced copy and run Lossless on it, which does not make it smaller, so the table shows with no
// download. The run is on all three browsers (playwright.features.config.ts).
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('reduce a file: the space table shows, the download is smaller, and a not-smaller run shows the table with no download', async ({
    page,
  }) => {
    const problems = watchPage(page);
    const original = fixture('images.pdf');
    await openApp(page);
    await openPdf(page, 'images.pdf', original);

    // The command palette opens from the ribbon's search box; Reduce File Size is its command.
    await page.getByRole('searchbox', { name: 'Search tools' }).click();
    await page.keyboard.type('Reduce File Size');
    await page.getByRole('option', { name: 'Reduce File Size', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reduce file size' });
    await expect(dialog).toBeVisible();

    // Smallest, then Compress: one job, and the result has the sizes and the space table.
    await dialog.getByRole('radio', { name: 'Smallest (screen)', exact: true }).check();
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

    // Reopen the reduced copy and run Lossless on it: the copy is not smaller, so the message
    // says so, the table still shows, and there is no download.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await openPdf(page, 'reduced.pdf', reduced);
    await page.getByRole('searchbox', { name: 'Search tools' }).click();
    await page.keyboard.type('Reduce File Size');
    await page.getByRole('option', { name: 'Reduce File Size', exact: true }).click();
    const again = page.getByRole('dialog', { name: 'Reduce file size' });
    await again.getByRole('radio', { name: 'Lossless', exact: true }).check();
    await again.getByRole('button', { name: 'Compress', exact: true }).click();
    await expect(again.getByRole('status')).toContainText('do not make the file smaller', {
      timeout: 120_000,
    });
    await expect(again.getByRole('table')).toBeVisible();
    await expect(again.getByRole('link', { name: /^Download / })).toHaveCount(0);

    expect(problems).toEqual([]);
  });
});
