// W7.9 A2: the attachments panel's add, save, open and remove, each with its Undo (W7.9 A1 engine).
// The flow runs on attachments.pdf (two embedded files, notes.txt and brief.pdf, unsigned): add
// memo.txt and Save it back (the bytes must be the added ones), Undo the add, open the PDF attachment
// as a new tab, remove notes.txt and Undo the remove, remove it again, then Save As and reopen: the
// removed entry is gone from the reopened file, and brief.pdf is still there.
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

// The panel's list of embedded files, and one row of it by the start of its name.
function entries(page: Page) {
  return page.getByRole('list', { name: 'Embedded files' }).getByRole('button');
}
function entry(page: Page, name: RegExp) {
  return entries(page).filter({ hasText: name });
}

// Opens the panel from the rail's Attachments button.
async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Attachments', exact: true }).click();
}

// Main menu, then the Save As… item (as in save-as.spec.ts), then the dialog's Save As button. The
// download is the saved copy; the file name is the tab's name, so it is read back as is.
async function saveAs(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: 'Main menu' }).click();
  await page.locator('.app-menu-item', { hasText: 'Save As…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save As' });
  await expect(dialog).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Save As', exact: true }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error(`download failed: ${await download.failure()}`);
  return readFileSync(path);
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('the panel adds, saves, removes and opens attachments (each undone), and the removal survives a save', async ({
    context,
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'attachments.pdf', fixture('attachments.pdf'));

    await openPanel(page);
    await expect(entry(page, /^notes\.txt/)).toBeVisible();
    await expect(entry(page, /^brief\.pdf/)).toBeVisible();

    // 1. Add a file: the picker opens from the Add button; the new entry is listed and selected.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Add file…', exact: true }).click(),
    ]);
    await chooser.setFiles({
      name: 'memo.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('memo\n'),
    });
    await expect(page.getByText('Added memo.txt.', { exact: true })).toBeVisible();
    await expect(entry(page, /^memo\.txt/)).toBeVisible();

    // 2. Save the selected file back: the download is named as the attachment, with the added bytes.
    const details = page.locator('.attachments-details');
    const [saved] = await Promise.all([
      page.waitForEvent('download'),
      details.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(saved.suggestedFilename()).toBe('memo.txt');
    const savedPath = await saved.path();
    if (!savedPath) throw new Error(`download failed: ${await saved.failure()}`);
    expect(readFileSync(savedPath)).toEqual(Buffer.from('memo\n'));

    // 3. Undo the add: the toast's Undo removes the entry from the list again.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(entry(page, /^memo\.txt/)).toHaveCount(0);

    // 4. Open the PDF attachment: it becomes a new tab named after the file.
    await entry(page, /^brief\.pdf/).click();
    await page.getByRole('button', { name: 'Open as new tab', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'brief.pdf' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: 'attachments.pdf' }).click();

    // 5. Remove notes.txt: the confirmation names it, then the entry goes; Undo brings it back.
    await entry(page, /^notes\.txt/).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page
      .locator('.redact-confirm')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(page.getByText('Removed notes.txt.', { exact: true })).toBeVisible();
    await expect(entry(page, /^notes\.txt/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(entry(page, /^notes\.txt/)).toBeVisible();

    // 6. Remove notes.txt again, then Save As and reopen the copy: the entry is gone from it.
    await entry(page, /^notes\.txt/).click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page
      .locator('.redact-confirm')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();
    await expect(entry(page, /^notes\.txt/)).toHaveCount(0);

    const bytes = await saveAs(page);
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, 'attachments.pdf', bytes);
    await openPanel(reopened);
    await expect(entry(reopened, /^brief\.pdf/)).toBeVisible();
    await expect(entry(reopened, /^notes\.txt/)).toHaveCount(0);

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });
});
