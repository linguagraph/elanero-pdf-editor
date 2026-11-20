// W6.7a S6: the object edit flow (W6.7a, W1.5 section 2). The Edit Text & Images tool outlines the
// page's content objects; a press selects one, a drag moves it, and Delete removes the selection.
// Each edit is one engine step, so the saved file carries it. The round trip checks the result
// outside the browser (pikepdf and pdfium, through the host replay): the image is gone from its old
// place and drawn in its new one, and the deleted heading no longer has text.
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

// The fixture's page size in points (A4), and the page point to CSS pixel mapping. The edit layer
// covers the page, so a point on the page is at the same fraction of the layer's box.
const PAGE_PT = { width: 595.2756, height: 841.8898 };

async function pagePixel(layer: Locator, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await layer.boundingBox();
  if (box === null) throw new Error('the edit layer is not laid out');
  return {
    x: box.x + (x / PAGE_PT.width) * box.width,
    y: box.y + (y / PAGE_PT.height) * box.height,
  };
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  // A taller viewport than the default 720 px, so a drag 150 points down stays on screen (Playwright
  // clamps a pointer that leaves the viewport, and the move would then be shorter than asked).
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('select, move and delete page objects: the saved file shows the edits', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'mixed_content.pdf', fixture('mixed_content.pdf'));

    // Edit Text & Images, from the ribbon's Edit tab, turns the tool on. The page's objects outline.
    await page.locator('.ribbon [role="tab"]', { hasText: /^Edit$/ }).click();
    await page.getByRole('button', { name: 'Edit Text & Images', exact: true }).click();
    const layer = page.locator('[data-page="0"] .edit-layer');
    await expect(layer).toBeVisible();
    await expect(layer.locator('.edit-outline').first()).toBeAttached({ timeout: 30_000 });

    // Select the image (120 by 100 points at 420, 80) with a press, then drag it 150 points down.
    // The press on the selected image starts a move, and the release commits it as one step. The
    // new place (420, 230 to 540, 330) touches no other object.
    const imageCentre = await pagePixel(layer, 480, 130);
    await page.mouse.click(imageCentre.x, imageCentre.y);
    await expect(layer.locator('.edit-outline--selected')).toHaveCount(1);
    const dropped = await pagePixel(layer, 480, 280);
    const viewport = page.viewportSize();
    expect(dropped.y).toBeLessThan(viewport?.height ?? 0);
    await page.mouse.move(imageCentre.x, imageCentre.y);
    await page.mouse.down();
    await page.mouse.move(dropped.x, dropped.y, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByText('Objects moved.', { exact: true })).toBeVisible();

    // Select the heading and delete it with the Delete key.
    const heading = await pagePixel(layer, 100, 54);
    await page.mouse.click(heading.x, heading.y);
    await expect(layer.locator('.edit-outline--selected')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(page.getByText('Objects deleted.', { exact: true })).toBeVisible();

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Reopen the saved bytes in a fresh page: the document opens with its one page.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 1' })).toBeVisible();

    // The host replay: one image is still on the page, nothing is left where it was (the old box is
    // blank white), and the moved image is drawn in its new box. The heading's text is gone and the
    // paragraph below it stays.
    recordHostCheck(testInfo, 'page_count_pikepdf', saved.bytes, { pages: 1 });
    recordHostCheck(testInfo, 'image_count_pikepdf', saved.bytes, { count: 1, page: 0 });
    recordHostCheck(testInfo, 'blank_region_pdfium', saved.bytes, {
      page: 0,
      clip: [420, 80, 540, 180],
    });
    recordHostCheck(testInfo, 'ink_region_pdfium', saved.bytes, {
      page: 0,
      clip: [420, 230, 540, 330],
    });
    recordHostCheck(testInfo, 'text_lacks_pdfium', saved.bytes, {
      page: 0,
      text: 'Mixed content heading',
    });
    recordHostCheck(testInfo, 'text_contains_pdfium', saved.bytes, {
      page: 0,
      text: 'A second paragraph that stays put.',
    });

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
