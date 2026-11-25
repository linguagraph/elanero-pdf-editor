// W8.1 S4: text markup from the text selection (W7.1a slice 5, #680). A word of page 1's heading is
// selected in the text layer, then Highlight on the Comment tab marks it: the Comments panel lists
// the highlight by its type, Undo removes it and Redo brings it back, and the saved file keeps it.
// The round trip checks the file outside the browser: pikepdf finds the /Highlight annotation, and
// pypdfium2 renders yellow ink in the word's rectangle (the highlight is drawn over the text).
import { expect, type Locator, type Page, test } from '@playwright/test';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// The Comment tab of the ribbon holds the markup commands and the Comments List button.
async function openCommentTab(page: Page): Promise<void> {
  await page.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
}

// The thread row that holds the text (or the type label) given.
function thread(list: Locator, text: string): Locator {
  return list.locator('.comments-thread', { hasText: text });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  // The flow runs on Chromium. The other engines are tracked in #420.
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'Chromium only: the other engines are tracked in #420',
  );
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('a highlight from a selected word: the panel lists it, undo and redo follow, the saved file keeps it', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    // Select the first word of page 1's heading ("Page", at 72 pt from the left, 72 pt from the top
    // in a 20 pt bold face). The drag runs from the line's start to a third of its width, which is
    // the end of that word in the text layer, so the selection covers it and no more.
    const heading = page.locator('[data-page="0"] .page-text-line').first();
    await expect(heading).toBeVisible();
    const line = await heading.boundingBox();
    if (line === null) throw new Error('page 1 heading has no box');
    const y = line.y + line.height / 2;
    await page.mouse.move(line.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(line.x + line.width / 3, y, { steps: 8 });
    await page.mouse.up();

    // Highlight marks the selection at once: one markup comment, and the Undo toast.
    await openCommentTab(page);
    await page.locator('.ribbon [data-command="highlight"]').click();
    await expect(page.getByText('Comment added.', { exact: true })).toBeVisible();

    // Undo: the toast's Undo removes the highlight. It is clicked first, because the toast
    // lives only a few seconds.
    await page.locator('.toast-action', { hasText: 'Undo' }).click();

    // The Comments panel is empty after the undo. With no thread the panel shows its empty status
    // line instead of the thread list, so the list is only expected again after the redo.
    await openCommentTab(page);
    await page.locator('.ribbon [data-command="comments-list"]').click();
    await expect(
      page.locator('.comments-status-line', { hasText: 'This document has no comments' }),
    ).toBeVisible();
    await expect(page.locator('.comments-thread')).toHaveCount(0);

    // Redo: the quick-access Redo brings the highlight back, with its type.
    await page.locator('.quick-access [data-command="redo"]').click();
    const list = page.getByRole('list', { name: 'Comment threads' });
    await expect(thread(list, 'Highlight')).toBeVisible();
    await expect(list.locator('.comments-thread')).toHaveCount(1);

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Host replay: one comment on page 1 (popups do not count), which is a /Highlight annotation
    // with /QuadPoints (pikepdf); its colour is drawn in the word's rectangle (pypdfium2). The clip
    // is the word's box in PDF points from the top left (x 70 to 125, y 50 to 80) at scale 1.
    recordHostCheck(testInfo, 'comment_count_pikepdf', saved.bytes, { count: 1, page: 0 });
    recordHostCheck(testInfo, 'annot_keys_pikepdf', saved.bytes, {
      subtype: '/Highlight',
      page: 0,
      present: ['/QuadPoints'],
    });
    recordHostCheck(testInfo, 'opens_pdfium', saved.bytes);
    recordHostCheck(testInfo, 'yellow_pixels_pdfium', saved.bytes, {
      page: 0,
      clip: [70, 50, 125, 80],
      minimum: 200,
    });

    // Reopen the saved bytes in a fresh page: the panel lists the highlight by its type.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await reopened.locator('[data-panel="comments"]').click();
    const reopenedList = reopened.getByRole('list', { name: 'Comment threads' });
    await expect(reopenedList).toBeVisible();
    await expect(reopenedList.locator('.comments-thread')).toHaveCount(1);
    await expect(thread(reopenedList, 'Highlight')).toBeVisible();

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
