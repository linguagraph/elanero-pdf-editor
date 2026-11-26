// W8.1 S4: comments (W7.1a tools, W7.1b panel). A sticky note and a rectangle are placed with the
// Comment tab's tools; the Comments panel lists them, takes a reply, a status and an edit, and the
// saved file keeps them. The round trip checks the file outside the browser (pikepdf, through the
// host replay): the annotations and the reply and status annotations that link to them. The
// reopened file's panel shows the same threads, so the saved file is what the user gets.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

// The Comment tab of the ribbon holds the sticky note and the rectangle tool.
async function openCommentTab(page: Page): Promise<void> {
  await page.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
}

// A point at (x, y) CSS pixels from the top left of a page's box, in the viewport.
async function pointOn(page: Page, index: number, x: number, y: number) {
  const box = await page.locator(`[data-page="${index}"]`).boundingBox();
  if (box === null) throw new Error(`page ${index + 1} is not laid out`);
  return { x: box.x + x, y: box.y + y };
}

// The Comments panel's thread rows. The panel opens from the rail; its list is labelled.
async function openComments(page: Page): Promise<Locator> {
  await page.locator('[data-panel="comments"]').click();
  const list = page.getByRole('list', { name: 'Comment threads' });
  await expect(list).toBeVisible();
  return list;
}

// A ribbon command, from the row or from the "More commands" menu. The Comment tab's Manage group is
// its last, so it is the first to move into the menu when the row is too narrow for the tab
// (ribbon/useGroupOverflow.ts). WebKit measures the row wider, so the group moves there at 1920 px
// too. A command in the menu is not rendered until the menu opens, so the row is checked first.
async function clickRibbonCommand(page: Page, command: string): Promise<void> {
  const row = page.locator(`.ribbon .ribbon-toolbar [data-command="${command}"]`);
  const more = page.locator('.ribbon .ribbon-more');
  await expect(row.or(more).first()).toBeVisible();
  if ((await row.count()) > 0) {
    await row.click();
    return;
  }
  await more.click();
  await page.locator(`[role="dialog"] [data-command="${command}"]`).click();
}

// The panel opens from the Comment tab's Comments List button (W7.1b S1), which shows it.
async function openCommentsFromRibbon(page: Page): Promise<Locator> {
  await openCommentTab(page);
  await clickRibbonCommand(page, 'comments-list');
  const list = page.getByRole('list', { name: 'Comment threads' });
  await expect(list).toBeVisible();
  return list;
}

// The thread row that holds the text (or the type label) given.
function thread(list: Locator, text: string): Locator {
  return list.locator('.comments-thread', { hasText: text });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  // A taller viewport than the default 720 px, so the page points used below stay on screen. At
  // 1280 px the Comment tab's Manage group overflows into "More commands" (clickRibbonCommand).
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('a sticky note, a rectangle, a reply, a status and an edit: the saved file keeps them', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await openCommentTab(page);

    // Sticky note: the tool is on, a click places it, and its text is typed into the note form.
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    const note = await pointOn(page, 0, 120, 150);
    await page.mouse.click(note.x, note.y);
    await page.getByRole('textbox', { name: 'Note text' }).fill('Check the margin');
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    // The note is added when the tool returns to Select (W7.1a): wait for that, so the Rectangle
    // click below is not reset by the note's reply arriving after it.
    await expect(page.getByRole('button', { name: 'Note', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Rectangle: a drag draws the box (a click alone would not).
    await page
      .getByRole('toolbar', { name: 'Ribbon' })
      .getByRole('button', { name: 'Rectangle', exact: true })
      .click();
    const from = await pointOn(page, 0, 150, 300);
    const to = await pointOn(page, 0, 350, 400);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    // The Comments panel lists both threads, the note by its text and the rectangle by its type.
    const list = await openCommentsFromRibbon(page);
    await expect(list.locator('.comments-thread')).toHaveCount(2);
    await expect(thread(list, 'Check the margin')).toBeVisible();
    const rectangle = thread(list, 'Rectangle');
    await expect(rectangle).toBeVisible();

    // Reply to the note: the reply box posts, and the reply shows under the note's thread.
    const noteRow = thread(list, 'Check the margin');
    await noteRow.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('textbox', { name: 'Reply text' }).fill('Agreed, I will fix it');
    await page.getByRole('button', { name: 'Post reply', exact: true }).click();
    await expect(page.getByText('Reply added.', { exact: true })).toBeVisible();
    await expect(noteRow.locator('.comments-replies')).toContainText('Agreed, I will fix it');

    // Status on the rectangle: the select writes a status, and the row shows it.
    await rectangle.getByRole('combobox', { name: 'Set status' }).selectOption('Accepted');
    await expect(rectangle.locator('.comments-status')).toHaveText('Accepted');

    // Edit the note's text: the editor replaces the row, and Save writes the new text.
    await noteRow.getByRole('button', { name: 'Edit', exact: true }).click();
    await list.getByLabel('Comment text', { exact: true }).fill('Check the margin twice');
    await list.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(thread(list, 'Check the margin twice')).toBeVisible();

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Host replay: the note, the rectangle, the reply and the status are four annotations on page 1
    // (the popups do not count). The reply is a text reply, then the status with its review state.
    recordHostCheck(testInfo, 'comment_count_pikepdf', saved.bytes, { count: 4, page: 0 });
    recordHostCheck(testInfo, 'irt_states_pikepdf', saved.bytes, { states: ['', 'Accepted'] });
    // pypdfium2 reads the same file: it opens with the five pages of text_multipage.
    recordHostCheck(testInfo, 'page_count_pdfium', saved.bytes, { pages: 5 });

    // Reopen the saved bytes in a fresh page: the panel lists the same threads, with the reply, the
    // status and the edited text.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    const reopenedList = await openComments(reopened);
    await expect(reopenedList.locator('.comments-thread')).toHaveCount(2);
    const editedNote = thread(reopenedList, 'Check the margin twice');
    await expect(editedNote.locator('.comments-replies')).toContainText('Agreed, I will fix it');
    await expect(thread(reopenedList, 'Rectangle').locator('.comments-status')).toHaveText(
      'Accepted',
    );

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });

  test('a comment made in another application: the status is set and saved', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    // annotations_unnamed has two rectangles and a note on page 1, with no names in the file, and a
    // redaction mark on page 2 (the panel lists it with the comments: four threads).
    await openPdf(page, 'annotations_unnamed.pdf', fixture('annotations_unnamed.pdf'));
    const list = await openComments(page);
    await expect(list.locator('.comments-thread')).toHaveCount(4);
    await expect(thread(list, 'Box one')).toBeVisible();
    await expect(thread(list, 'Note three')).toBeVisible();

    // Set the status of the second box: the file gets one status reply, and nothing else changes.
    await thread(list, 'Box two')
      .getByRole('combobox', { name: 'Set status' })
      .selectOption('Rejected');
    await expect(page.getByText('Status set.', { exact: true })).toBeVisible();

    const saved = await saveDownload(page);
    recordHostCheck(testInfo, 'irt_states_pikepdf', saved.bytes, { states: ['Rejected'] });
    recordHostCheck(testInfo, 'opens_pdfium', saved.bytes);

    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    const reopenedList = await openComments(reopened);
    await expect(thread(reopenedList, 'Box two').locator('.comments-status')).toHaveText(
      'Rejected',
    );

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });

  test('export the comments from the panel, then import them into a fresh copy', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await openCommentTab(page);
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    const note = await pointOn(page, 0, 120, 150);
    await page.mouse.click(note.x, note.y);
    await page.getByRole('textbox', { name: 'Note text' }).fill('Imported note text');
    await page.getByRole('button', { name: 'Add note', exact: true }).click();

    // Export: the panel's Export opens the Export dialog, whose default format is XFDF.
    const list = await openCommentsFromRibbon(page);
    await expect(thread(list, 'Imported note text')).toBeVisible();
    await page.getByRole('button', { name: 'Export comments', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Export', exact: true }).click(),
    ]);
    const exported = await download.path();
    if (!exported) throw new Error(`export failed: ${await download.failure()}`);
    const xfdf = readFileSync(exported);
    expect(xfdf.toString('utf8').startsWith('<?xml')).toBe(true);
    expect(xfdf.toString('utf8')).toContain('Imported note text');

    // Import: a fresh copy of the same document has no comments, so its panel shows Import only.
    const fresh = await context.newPage();
    const freshProblems = watchPage(fresh);
    await openApp(fresh);
    await openPdf(fresh, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await openCommentTab(fresh);
    await clickRibbonCommand(fresh, 'comments-list');
    await expect(fresh.getByRole('button', { name: 'Import comments', exact: true })).toBeVisible();
    await expect(fresh.getByRole('button', { name: 'Export comments', exact: true })).toHaveCount(
      0,
    );

    await fresh.getByRole('button', { name: 'Import comments', exact: true }).click();
    const importDialog = fresh.getByRole('dialog');
    await importDialog.locator('input[type="file"]').setInputFiles({
      name: download.suggestedFilename(),
      mimeType: 'application/xml',
      buffer: xfdf,
    });
    await expect(importDialog.getByText(/Comments: 1 \(replies: 0\)/)).toBeVisible();
    await importDialog.getByRole('button', { name: 'Import', exact: true }).click();

    const freshList = fresh.getByRole('list', { name: 'Comment threads' });
    await expect(freshList.locator('.comments-thread')).toHaveCount(1);
    await expect(thread(freshList, 'Imported note text')).toBeVisible();

    // Host replay: the imported note is the one comment on page 1 of the saved file.
    const saved = await saveDownload(fresh);
    recordHostCheck(testInfo, 'comment_count_pikepdf', saved.bytes, { count: 1, page: 0 });
    recordHostCheck(testInfo, 'opens_pdfium', saved.bytes);

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(freshProblems, 'CSP or page errors after import').toEqual([]);
  });
});
