// W8.1 S5: the bookmarks panel's edits (W5.2). The flow runs on outline.pdf (six pages, Chapter 1 to 3
// with two sections each, Roman page labels): rename a chapter, move a section up, re-target a
// section to the current page, delete one and undo the delete, and add a bookmark. The panel tree is
// checked after each step, then the saved file is reopened in a fresh page and its tree is checked
// again. The host checks read the saved bytes with pikepdf and pypdfium2.
import { expect, type Page, test } from '@playwright/test';
import {
  STAGED,
  fixture,
  openApp,
  openPdf,
  recordHostCheck,
  saveDownload,
  watchPage,
} from './support';

type Row = [level: number, title: string];

// The panel's tree, top to bottom: each row's level (aria-level) and title.
async function expectTree(page: Page, rows: Row[]): Promise<void> {
  const items = page.getByRole('tree', { name: 'Document bookmarks' }).getByRole('treeitem');
  await expect(items).toHaveText(rows.map(([, title]) => title));
  for (const [index, [level]] of rows.entries()) {
    await expect(items.nth(index)).toHaveAttribute('aria-level', String(level));
  }
}

// Makes a row the current one, which is what the toolbar acts on. A click would also open the page
// the row points to, so the row is focused instead (focusing a row only makes it current).
async function focusRow(page: Page, title: string): Promise<void> {
  await page
    .getByRole('tree', { name: 'Document bookmarks' })
    .getByRole('treeitem', { name: title, exact: true })
    .focus();
}

// Opens each named chapter that is closed. The panel starts an entry closed unless the file flags it
// open, and outline.pdf does not, so the sections are only in the tree after this. Right on a closed
// row opens it (the tree pattern); a row already open is left alone, so the helper is safe to run on
// a file that does flag its chapters.
async function expandChapters(page: Page, titles: string[]): Promise<void> {
  const tree = page.getByRole('tree', { name: 'Document bookmarks' });
  for (const title of titles) {
    const row = tree.getByRole('treeitem', { name: title, exact: true });
    await expect(row).toHaveAttribute('aria-expanded', /^(true|false)$/);
    if ((await row.getAttribute('aria-expanded')) === 'false') {
      await focusRow(page, title);
      await page.keyboard.press('ArrowRight');
      await expect(row).toHaveAttribute('aria-expanded', 'true');
    }
  }
}

function toolbarButton(page: Page, name: string) {
  return page
    .getByRole('toolbar', { name: 'Bookmark actions' })
    .getByRole('button', { name, exact: true });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('the panel renames, moves, re-targets, deletes (and undoes) and adds bookmarks; the saved file keeps them', async ({
    context,
    page,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'outline.pdf', fixture('outline.pdf'));

    // The panel opens from the rail's Bookmarks button.
    await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await expandChapters(page, ['Chapter 1', 'Chapter 2', 'Chapter 3']);
    await expectTree(page, [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [2, 'Section 1.2'],
      [1, 'Chapter 2'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.1'],
      [2, 'Section 3.2'],
    ]);

    // 1. Rename Chapter 2 to Part Two: the Rename button opens the title field on the row.
    await focusRow(page, 'Chapter 2');
    await toolbarButton(page, 'Rename').click();
    const titleField = page.getByRole('textbox', { name: 'Bookmark title' });
    await expect(titleField).toBeVisible();
    await titleField.fill('Part Two');
    await titleField.press('Enter');
    await expect(page.getByText('Bookmark renamed.', { exact: true })).toBeVisible();
    await expectTree(page, [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [2, 'Section 1.2'],
      [1, 'Part Two'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.1'],
      [2, 'Section 3.2'],
    ]);

    // 2. Move Section 3.2 up: it becomes the first child of Chapter 3.
    await focusRow(page, 'Section 3.2');
    await toolbarButton(page, 'Move Up').click();
    await expect(
      page.getByText('Moved "Section 3.2" to level 2, position 1 of 2.', { exact: true }),
    ).toBeVisible();
    await expectTree(page, [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [2, 'Section 1.2'],
      [1, 'Part Two'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.2'],
      [2, 'Section 3.1'],
    ]);

    // 3. Re-target Section 2.2 to page 2. The page field moves the view to page 2 first; the row is
    // focused, not clicked, because a click would open its own page (page 4). The field shows the
    // current page's label, and outline.pdf's labels are Roman, so page 2 reads "ii".
    const jump = page.getByRole('textbox', { name: 'Go to page' });
    await jump.fill('2');
    await jump.press('Enter');
    await expect(jump).toHaveValue('ii');
    await focusRow(page, 'Section 2.2');
    await toolbarButton(page, 'Set to Current Page').click();
    await expect(page.getByText('Bookmark now goes to page 2.', { exact: true })).toBeVisible();

    // 4. Delete Section 1.2, then Undo from its toast: the row is back in its place.
    await focusRow(page, 'Section 1.2');
    await toolbarButton(page, 'Delete').click();
    const deleted = page.locator('.toast', { hasText: 'Deleted "Section 1.2".' });
    await expect(deleted).toBeVisible();
    await expectTree(page, [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [1, 'Part Two'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.2'],
      [2, 'Section 3.1'],
    ]);
    await deleted.locator('.toast-action', { hasText: 'Undo' }).click();
    await expectTree(page, [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [2, 'Section 1.2'],
      [1, 'Part Two'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.2'],
      [2, 'Section 3.1'],
    ]);

    // 5. Add: the new bookmark goes after the focused row's whole subtree. Chapter 3 is the last
    // top-level entry, so the new one lands at the end of the top level. Its title is "Page" plus the
    // page's label (outline.pdf has Roman labels, so page 2 is "ii"), and its title field opens.
    await focusRow(page, 'Chapter 3');
    await toolbarButton(page, 'Add').click();
    await expect(page.getByText('Added "Page ii" for page 2.', { exact: true })).toBeVisible();
    const newTitle = page.getByRole('textbox', { name: 'Bookmark title' });
    await expect(newTitle).toBeVisible();
    await newTitle.press('Escape');
    const finalRows: Row[] = [
      [1, 'Chapter 1'],
      [2, 'Section 1.1'],
      [2, 'Section 1.2'],
      [1, 'Part Two'],
      [2, 'Section 2.1'],
      [2, 'Section 2.2'],
      [1, 'Chapter 3'],
      [2, 'Section 3.2'],
      [2, 'Section 3.1'],
      [1, 'Page ii'],
    ];
    await expectTree(page, finalRows);

    // 6. Save, then reopen the download in a fresh page: the same tree, and the host checks on the bytes.
    const saved = await saveDownload(page);
    recordHostCheck(testInfo, 'outline_pikepdf', saved.bytes, {
      expected: finalRows,
    });
    recordHostCheck(testInfo, 'outline_pdfium', saved.bytes, {
      rows: [
        [1, 'Chapter 1', 0],
        [2, 'Section 1.1', 0],
        [2, 'Section 1.2', 1],
        [1, 'Part Two', 2],
        [2, 'Section 2.1', 2],
        [2, 'Section 2.2', 1],
        [1, 'Chapter 3', 4],
        [2, 'Section 3.2', 5],
        [2, 'Section 3.1', 4],
        [1, 'Page ii', 1],
      ],
    });
    recordHostCheck(testInfo, 'page_count_pikepdf', saved.bytes, { pages: 6 });

    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await reopened.getByRole('button', { name: 'Bookmarks', exact: true }).click();
    // The saved file may not flag the chapters open, so they are opened the same way as before.
    await expandChapters(reopened, ['Chapter 1', 'Part Two', 'Chapter 3']);
    await expectTree(reopened, finalRows);

    expect(problems).toEqual([]);
    expect(reopenedProblems).toEqual([]);
  });
});
