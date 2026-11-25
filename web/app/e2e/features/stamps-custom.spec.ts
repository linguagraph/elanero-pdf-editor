// W7.3b S2 round trip: a custom PNG stamp is added from the Stamp menu, placed on a page, undone and
// redone, saved, and checked outside the browser. The saved file holds a /Stamp annotation with an
// image appearance (pikepdf) and dark ink where it was placed (pypdfium2). Reopened, the comments
// panel lists it; after a reload the library (OPFS) still offers it in the menu.
// Chromium only for now: Firefox and WebKit are tracked in #420.
import { expect, type Page, test } from '@playwright/test';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  pageSize,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// A 40 by 20 solid blue PNG, as fixed base64 bytes (the file the picker is given).
const STAMP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAI0lEQVR4nGNgYFgwQGjU4lGLRy0etXjU4lGLRy0etXjEWAwA58v0EBa4E0YAAAAASUVORK5CYII=',
  'base64',
);
// The library label is the file name without its extension, with _ as spaces (stampLabel).
const FILE_NAME = 'Test_Mark.png';
const LABEL = 'Test Mark';
const ADD_LABEL = 'Add Custom Stamp…';
// A4 in points (text_multipage.pdf is A4): the page box's CSS width maps to this many points.
const A4_WIDTH = 595.28;

// The Stamp menu sits in the view bar; its button and menu are confirmed in stampTool.tsx. The
// menu's aria-label is "Stamps", but react-aria also labels it by its trigger ("Stamp"), so the
// accessible name is "Stamp" (or "Stamps Stamp"); matching "Stamp" finds it either way.
async function openStampMenu(page: Page): Promise<void> {
  await page.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
  await page.locator('.stamp-menu-button').click();
  await expect(page.getByRole('menu', { name: 'Stamp' })).toBeVisible();
}

// Adds the PNG through Add Custom Stamp: the menu item opens the browser's picker (a file chooser).
async function addCustomStamp(page: Page): Promise<void> {
  await openStampMenu(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: ADD_LABEL, exact: true }).click(),
  ]);
  await chooser.setFiles({ name: FILE_NAME, mimeType: 'image/png', buffer: STAMP_PNG });
  await expect(page.getByText(`Custom stamp “${LABEL}” added.`, { exact: true })).toBeVisible();
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  test.skip(({ browserName }) => browserName !== 'chromium', 'Firefox and WebKit: tracked in #420');

  test('a custom stamp: added, placed, undone, redone, saved; kept after a reload', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await addCustomStamp(page);

    // The stamp tool is now the active tool: a click on page 1 places the stamp, centred on it.
    const box = await page.locator('[data-page="0"]').boundingBox();
    if (box === null) throw new Error('page 1 is not laid out');
    await page.mouse.click(box.x + 150, box.y + 200);
    const size = await pageSize(page, 0);
    const k = A4_WIDTH / size.width; // points per CSS pixel
    const [cx, cy] = [150 * k, 200 * k];
    await expect(page.getByRole('button', { name: 'Undo', exact: true }).first()).toBeEnabled();

    // Undo removes the stamp, Redo puts it back.
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'Redo', exact: true }).first()).toBeEnabled();
    await page.getByRole('button', { name: 'Redo', exact: true }).first().click();

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // pikepdf: a /Stamp annotation with /Name, whose appearance draws an image. pypdfium2: dark
    // ink in the 50 by 50 point box round the click (the stamp is 40 by 20 pixels, centred).
    recordHostCheck(testInfo, 'stamp_image_pikepdf', saved.bytes, { page: 0 });
    recordHostCheck(testInfo, 'annot_keys_pikepdf', saved.bytes, {
      subtype: '/Stamp',
      page: 0,
      present: ['/Name'],
    });
    recordHostCheck(testInfo, 'ink_region_pdfium', saved.bytes, {
      page: 0,
      clip: [cx - 25, cy - 25, cx + 25, cy + 25],
    });

    // Reopened in a fresh page, the comments panel lists the stamp's thread.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await reopened.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
    await reopened.locator('.ribbon [data-command="comments-list"]').click();
    const list = reopened.getByRole('list', { name: 'Comment threads' });
    await expect(list).toBeVisible();
    await expect(list.locator('.comments-thread')).toHaveCount(1);

    // A reload keeps the library: the custom stamp is still in the menu (OPFS).
    await page.reload();
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await openStampMenu(page);
    await expect(page.getByRole('menuitem', { name: LABEL, exact: true })).toBeVisible();

    expect(problems).toEqual([]);
    expect(reopenedProblems).toEqual([]);
  });
});
