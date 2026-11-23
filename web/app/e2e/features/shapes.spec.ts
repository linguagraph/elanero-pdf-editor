// W6.7b slice 3a: Shape Style. The style dialog sets the outline, the fill and the width of the
// shape drawn next; the saved file carries them. The round trip checks the result outside the
// browser (pikepdf and pdfium, through the host replay): the outline is red and 6 pt wide, the
// fill is blue, and the pixels agree. The dialog also opens and closes from the keyboard.
import { expect, type Locator, test } from '@playwright/test';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// The fixture's page size in points (A4), and the page point to CSS pixel mapping. The shape layer
// covers the page, so a point on the page is at the same fraction of the layer's box.
const PAGE_PT = { width: 595.2756, height: 841.8898 };

async function pagePixel(layer: Locator, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await layer.boundingBox();
  if (box === null) throw new Error('the shape layer is not laid out');
  return {
    x: box.x + (x / PAGE_PT.width) * box.width,
    y: box.y + (y / PAGE_PT.height) * box.height,
  };
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('a styled rectangle is drawn and saved with its outline and fill', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'mixed_content.pdf', fixture('mixed_content.pdf'));

    // Shape Style… from the Edit tab's Shapes group. Red outline, blue fill, 6 pt, then OK.
    await page.locator('.ribbon [role="tab"]', { hasText: /^Edit$/ }).click();
    await page.getByRole('button', { name: 'Shape Style…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Shape Style' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Outline colour').fill('#ff0000');
    await dialog.getByLabel('Fill', { exact: true }).check();
    await dialog.getByLabel('Fill colour').fill('#0000ff');
    await dialog.getByLabel('Line width (pt)').fill('6');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Rectangle, then a drag from (100, 500) to (200, 560) in points. The ribbon's Rectangle is the
    // shape tool (add-rectangle); the view's Comment tools group has a Rectangle markup tool too.
    await page
      .getByRole('toolbar', { name: 'Ribbon' })
      .getByRole('button', { name: 'Rectangle', exact: true })
      .click();
    const layer = page.locator('[data-page="0"] .shape-layer');
    await expect(layer).toBeVisible();
    // At Fit Width the A4 page is taller than the view, and the box's place is below the view's
    // bottom, so a pointer there would miss the page. The view scrolls the box's middle (y 530) to
    // its centre first.
    const scroller = page.locator('.doc-view-scroll');
    const view = await scroller.boundingBox();
    if (view === null) throw new Error('the document view is not laid out');
    const middle = await pagePixel(layer, 150, 530);
    await scroller.evaluate((el, dy) => el.scrollBy(0, dy), middle.y - (view.y + view.height / 2));
    const start = await pagePixel(layer, 100, 500);
    const stop = await pagePixel(layer, 200, 560);
    expect(start.y).toBeGreaterThan(view.y);
    expect(stop.y).toBeLessThan(view.y + view.height);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(stop.x, stop.y, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByText('Shape added.', { exact: true })).toBeVisible();

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 1' })).toBeVisible();

    // The host replay: the last shape is a rectangle with a 6 pt red outline and a blue fill. The
    // outline's middle is red, and the box's middle is blue.
    recordHostCheck(testInfo, 'shape_operators_pikepdf', saved.bytes, {
      page: 0,
      kind: 'rectangle',
      width: 6,
      stroke: [1, 0, 0],
      fill: [0, 0, 1],
    });
    recordHostCheck(testInfo, 'pixel_red_pdfium', saved.bytes, { page: 0, x: 100, y: 530 });
    recordHostCheck(testInfo, 'pixel_blue_pdfium', saved.bytes, { page: 0, x: 150, y: 530 });

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });

  test('Shape Style opens and closes from the keyboard', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'mixed_content.pdf', fixture('mixed_content.pdf'));

    await page.locator('.ribbon [role="tab"]', { hasText: /^Edit$/ }).click();
    const button = page.getByRole('button', { name: 'Shape Style…', exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Shape Style' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
