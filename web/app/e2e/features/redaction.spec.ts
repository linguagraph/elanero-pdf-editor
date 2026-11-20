// W8.1 S6: redaction (W7.4, W4.12, W4.13). Marks are made for whole pages (Mark Pages) or from the
// text selection (Mark Text), listed and deleted in the Redactions panel, and applied after a
// confirmation. The leak test saves the applied file and checks it outside the browser (pikepdf and
// pdfium, through the host replay): the marked text is gone from the extracted text, and the pixels
// under the mark are the black fill, so the image under it is removed too.
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

// The ribbon's Protect tab holds Mark Text, Mark Pages and Apply.
async function openProtect(page: Page): Promise<void> {
  await page.locator('.ribbon [role="tab"]', { hasText: 'Protect' }).click();
}

// The document toolbar's redaction group: its marks count and its Clear and Apply buttons.
function redactBar(page: Page) {
  return page.getByRole('group', { name: 'Redaction', exact: true });
}

// The Redactions panel's rail button; its name gains the item count when there are marks.
function redactionsRail(page: Page) {
  return page.getByRole('button', { name: /^Redactions/ });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('mark the page, apply, save: the saved file leaks nothing', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'sensitive.pdf', fixture('sensitive.pdf'));
    await openProtect(page);

    // Mark Pages: the current page (the only page), through the dialog's Mark button.
    await page.getByRole('button', { name: 'Mark Pages', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark Pages' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Current page (1)').check();
    await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
    await expect(page.getByText('Marked 1 page for redaction.', { exact: true })).toBeVisible();
    await expect(redactBar(page).getByText('1 marked', { exact: true })).toBeVisible();

    // The Redactions panel lists the mark on page 1; the row can be selected there.
    await redactionsRail(page).click();
    const rows = page.getByRole('listbox', { name: 'Redaction marks' }).getByRole('option');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Page 1');
    await rows.first().click();
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');

    // Apply asks first; the confirmation removes the content under the mark.
    await redactBar(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Apply redactions?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Apply now', exact: true }).click();
    await expect(page.getByText('Redactions applied.', { exact: true })).toBeVisible();
    await expect(redactBar(page).getByText('0 marked', { exact: true })).toBeVisible();

    const saved = await saveDownload(page);
    expect(saved.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // Reopen the saved bytes in a fresh page: the document opens with its page.
    const reopened = await context.newPage();
    const reopenedProblems = watchPage(reopened);
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);
    await expect(reopened.getByRole('group', { name: 'Page 1 of 1' })).toBeVisible();

    // The leak test (AGENTS.md), on the saved bytes, through the host replay. The page's marked
    // text is gone (the email and the SSN are in it), and the render of the page inside the mark
    // is the black fill (the image under the text is removed too).
    recordHostCheck(testInfo, 'page_count_pikepdf', saved.bytes, { pages: 1 });
    recordHostCheck(testInfo, 'doc_text_lacks_pdfium', saved.bytes, {
      text: 'jane.example@example.com',
    });
    recordHostCheck(testInfo, 'doc_text_lacks_pdfium', saved.bytes, { text: '123-45-6789' });
    recordHostCheck(testInfo, 'crop_one_colour_pdfium', saved.bytes, {
      page: 0,
      box: [70, 110, 400, 210],
      expected: [0, 0, 0],
      tolerance: 40,
    });

    expect(problems, 'CSP or page errors').toEqual([]);
    expect(reopenedProblems, 'CSP or page errors after reopen').toEqual([]);
  });

  test('mark whole pages, delete one mark in the panel, then clear the rest', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await openProtect(page);

    // Mark Pages: all five pages, through the dialog's Mark button.
    await page.getByRole('button', { name: 'Mark Pages', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark Pages' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('All pages (5)').check();
    await dialog.getByRole('button', { name: 'Mark', exact: true }).click();
    await expect(page.getByText('Marked 5 pages for redaction.', { exact: true })).toBeVisible();
    await expect(redactBar(page).getByText('5 marked', { exact: true })).toBeVisible();

    // The panel lists one mark per page. Delete removes the selected one.
    await redactionsRail(page).click();
    const listbox = page.getByRole('listbox', { name: 'Redaction marks' });
    const rows = listbox.getByRole('option');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(2)).toContainText('Page 3');
    await rows.nth(2).click();
    await page
      .locator('.redactions-toolbar')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(rows).toHaveCount(4);
    await expect(redactBar(page).getByText('4 marked', { exact: true })).toBeVisible();
    await expect(listbox).not.toContainText('Page 3');

    // Clear marks removes the rest; the panel then says there are none.
    await redactBar(page).getByRole('button', { name: 'Clear marks', exact: true }).click();
    await expect(redactBar(page).getByText('0 marked', { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'no redaction marks' })).toBeVisible();

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  // BLOCKED: the engine's text.layer reply carries two buffers, and the worker RPC allows one
  // (web/app/src/engine/loader.ts: "a reply carries at most one buffer"), so the page's text lines
  // never arrive and no text can be selected. Mark Text stays unrun until that is fixed; the flow
  // is written here so it can be enabled then. The issue is to be opened by the coordinator.
  test.fixme('mark text on a selection, apply, save: the saved file leaks nothing', async ({
    page,
    context,
  }, testInfo) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'sensitive.pdf', fixture('sensitive.pdf'));
    await openProtect(page);

    // Select the email line and the SSN line, one Mark Text press each.
    for (const text of ['Email: jane', 'SSN: 123']) {
      const line = page.locator('.page-text-line', { hasText: text }).first();
      await expect(line).toBeVisible();
      await line.evaluate((element) => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      await page.getByRole('button', { name: 'Mark Text', exact: true }).click();
    }
    await expect(redactBar(page).getByText('2 marked', { exact: true })).toBeVisible();

    await redactBar(page).getByRole('button', { name: 'Apply redactions', exact: true }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: 'Apply redactions?' })
      .getByRole('button', { name: 'Apply now', exact: true })
      .click();
    await expect(page.getByText('Redactions applied.', { exact: true })).toBeVisible();

    const saved = await saveDownload(page);
    const reopened = await context.newPage();
    await openApp(reopened);
    await openPdf(reopened, saved.name, saved.bytes);

    recordHostCheck(testInfo, 'doc_text_lacks_pdfium', saved.bytes, {
      text: 'jane.example@example.com',
    });
    recordHostCheck(testInfo, 'doc_text_lacks_pdfium', saved.bytes, { text: '123-45-6789' });
    recordHostCheck(testInfo, 'text_contains_pdfium', saved.bytes, {
      page: 0,
      text: 'Public paragraph that must survive.',
    });
    recordHostCheck(testInfo, 'crop_one_colour_pdfium', saved.bytes, {
      page: 0,
      box: [80, 121, 250, 127],
      expected: [0, 0, 0],
      tolerance: 40,
    });

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
