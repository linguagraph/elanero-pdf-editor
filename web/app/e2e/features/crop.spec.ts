// W8.1 S5: crop (W4.11). The Crop Pages dialog takes four margins in points and crops every page;
// the visible page shrinks by the margins, and the Undo toast brings the page back. The cropped
// file is checked outside the browser (pikepdf reads its CropBox, pdfium opens it): the box is the
// page less the margins on each side.
import { expect, test } from '@playwright/test';
import {
  STAGED,
  cropAllPages,
  fixture,
  openApp,
  openPdf,
  pageSize,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// The A4 page make_fixtures.py writes (pymupdf.paper_rect("a4")), in points.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const CROPPED_W = PAGE_W - 2 * MARGIN;
const CROPPED_H = PAGE_H - 2 * MARGIN;

// The page's width over its height: the shape a crop changes.
const aspect = (size: { width: number; height: number }): number => size.width / size.height;

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('crop the margins, see the page shrink, undo it, then crop again and save', async ({
    browserName,
    page,
    context,
  }, testInfo) => {
    test.fixme(
      browserName === 'webkit',
      'WebKit: the style-src CSP refuses a stylesheet (console message), so the CSP check fails there; needs an issue',
    );
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await expect(page.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
    const before = await pageSize(page, 0);
    expect(aspect(before)).toBeCloseTo(PAGE_W / PAGE_H, 2);

    // Crop: the margins go in through the dialog, and every page takes them.
    await cropAllPages(page, MARGIN, 5);
    await expect
      .poll(async () => aspect(await pageSize(page, 0)))
      .toBeCloseTo(CROPPED_W / CROPPED_H, 2);

    // Undo (the toast's button): the page is its size again, and the toast is gone.
    await page.locator('.toast-action', { hasText: 'Undo' }).click();
    await expect.poll(async () => aspect(await pageSize(page, 0))).toBeCloseTo(aspect(before), 2);

    // Crop again and save: the saved file keeps the crop on every page.
    await cropAllPages(page, MARGIN, 5);
    await expect
      .poll(async () => aspect(await pageSize(page, 0)))
      .toBeCloseTo(CROPPED_W / CROPPED_H, 2);
    const saved = await saveDownload(page);
    expect(saved.name).toBe('text_multipage.pdf');

    // Reopen the saved bytes in a fresh page: the visible page is still the cropped size.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
    await expect
      .poll(async () => aspect(await pageSize(reopened, 0)))
      .toBeCloseTo(CROPPED_W / CROPPED_H, 2);

    recordHostCheck(testInfo, 'crop_box_size_pikepdf', saved.bytes, {
      width: CROPPED_W,
      height: CROPPED_H,
      page: 0,
    });
    recordHostCheck(testInfo, 'crop_box_size_pikepdf', saved.bytes, {
      width: CROPPED_W,
      height: CROPPED_H,
      page: 4,
    });
    recordHostCheck(testInfo, 'page_count_pdfium', saved.bytes, { pages: 5 });

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
