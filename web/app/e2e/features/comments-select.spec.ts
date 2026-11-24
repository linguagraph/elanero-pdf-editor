// W7.1a: the Select tool's comment selection on the web (slices 6 to 9). A click selects a comment, a
// Ctrl-click adds one, and Delete removes the selection. A rectangle is dragged with the mouse, moved
// with the arrow keys (a held key is one undo step) and resized by its bottom-right handle; the saved
// file keeps the last box, checked as /Rect with pikepdf, and it opens in pypdfium2.
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  STAGED,
  watchPage,
} from './support';

// The fixture's pages are A4 (scripts/make_fixtures.py), so a page's CSS box maps to points this way.
const PAGE_W_PT = 595;
const PAGE_H_PT = 842;

async function openCommentTab(page: Page): Promise<void> {
  await page.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the element is not laid out');
  return box;
}

// A point at (x, y) CSS pixels from the top left of page 1's box, in the viewport.
async function pointOn(page: Page, x: number, y: number) {
  const box = await boxOf(page.locator('[data-page="0"]'));
  return { x: box.x + x, y: box.y + y };
}

// A note at (120, 150). The Note tool stays on after a note is added, as the rectangle tool does.
async function addNote(page: Page): Promise<void> {
  await openCommentTab(page);
  await page.locator('.ribbon [data-command="sticky-note"]').click();
  const at = await pointOn(page, 120, 150);
  await page.mouse.click(at.x, at.y);
  await page.getByRole('textbox', { name: 'Note text' }).fill('Check the margin');
  await page.getByRole('button', { name: 'Add note', exact: true }).click();
}

// A rectangle from (150, 300) to (350, 400). Its tool is pressed again to turn it off: the Select
// layer is drawn only when no comment tool is on.
async function addRectangle(page: Page): Promise<void> {
  await openCommentTab(page);
  await page.locator('.ribbon [data-command="rectangle"]').click();
  const from = await pointOn(page, 150, 300);
  const to = await pointOn(page, 350, 400);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.locator('.ribbon [data-command="rectangle"]').click();
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  // The flow runs on Chromium. The other engines are tracked in #420.
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Chromium only: the other engines are tracked in #420',
  );
  test.use({ viewport: { width: 1280, height: 1000 } });

  test('a click selects, a Ctrl-click adds, Delete removes: the panel lists none', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await addNote(page);
    await addRectangle(page);

    // A click selects the rectangle; a Ctrl-click on the note adds it to the selection.
    const centre = await pointOn(page, 250, 350);
    await page.mouse.click(centre.x, centre.y);
    await expect(page.locator('.comment-select-outline')).toHaveCount(1);
    const note = await pointOn(page, 125, 155);
    await page.keyboard.down('Control');
    await page.mouse.click(note.x, note.y);
    await page.keyboard.up('Control');
    await expect(page.locator('.comment-select-outline')).toHaveCount(2);

    // Delete removes both, and the Comments panel then has no threads.
    await page.keyboard.press('Delete');
    await expect(page.locator('.comment-select-outline')).toHaveCount(0);
    await page.locator('[data-panel="comments"]').click();
    await expect(page.locator('.comments-thread')).toHaveCount(0);
    await expect(page.locator('.comments-status-line')).toBeVisible();

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a rectangle is dragged, moved by the arrows and resized: the saved /Rect is the last box', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await addRectangle(page);
    const outline = page.locator('.comment-select-outline');
    const centre = await pointOn(page, 250, 350);
    await page.mouse.click(centre.x, centre.y);
    await expect(outline).toHaveCount(1);

    // Drag: the mouse moves the selected rectangle by 60 and 40 CSS pixels.
    const start = await boxOf(outline);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 60, centre.y + 40, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await boxOf(outline)).x).toBeGreaterThan(start.x + 30);

    // Arrows: the list item takes the focus. Three presses of one held key are one undo step.
    const moved = await boxOf(outline);
    const pageBox = await boxOf(page.locator('[data-page="0"]'));
    const pxPerPt = pageBox.width / PAGE_W_PT;
    await page.locator('.comment-list-item').focus();
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await expect
      .poll(async () => Math.abs((await boxOf(outline)).x - (moved.x + 3 * pxPerPt)))
      .toBeLessThan(0.5);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => Math.abs((await boxOf(outline)).x - moved.x)).toBeLessThan(0.5);

    // Resize: the bottom-right handle (index 7 of the eight) moves by 40 and 30 CSS pixels.
    const handle = await boxOf(page.locator('.comment-select-handle').nth(7));
    const hx = handle.x + handle.width / 2;
    const hy = handle.y + handle.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 40, hy + 30, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await boxOf(outline)).width).toBeGreaterThan(moved.width + 20);

    // The outline is the saved box, in points with the origin at the bottom left (the /Rect).
    const last = await boxOf(outline);
    const left = ((last.x - pageBox.x) * PAGE_W_PT) / pageBox.width;
    const right = ((last.x + last.width - pageBox.x) * PAGE_W_PT) / pageBox.width;
    const top = ((last.y - pageBox.y) * PAGE_H_PT) / pageBox.height;
    const bottom = ((last.y + last.height - pageBox.y) * PAGE_H_PT) / pageBox.height;
    const rect = [left, PAGE_H_PT - bottom, right, PAGE_H_PT - top];

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // The outline has a border of a few pixels, so the tolerance is a few points.
    recordHostCheck(testInfo, 'annot_rect_pikepdf', saved.bytes, {
      page: 0,
      subtype: '/Square',
      rect,
      tol: 3,
    });
    recordHostCheck(testInfo, 'opens_pdfium', saved.bytes);

    // Reopen the saved bytes: the panel lists the rectangle.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await reopened.locator('[data-panel="comments"]').click();
    const list = reopened.getByRole('list', { name: 'Comment threads' });
    await expect(list.locator('.comments-thread')).toHaveCount(1);
    await expect(list).toContainText('Rectangle');

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
