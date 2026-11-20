// W8.1 S3: paging, the Go to Page field and the Back and Forward history (W5.3). The flows are
// read-only, so nothing is saved and no host check is recorded. text_multipage has five pages;
// page_labels has eight pages under four label rules, so the field takes a label as well as a page.
import { expect, type Page, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

// The share of one page's box that lies inside the scroll area (0 when it is not rendered). A jump
// is checked by this, since the page field only shows the page at the middle of the viewport.
function visibleShare(page: Page, index: number): Promise<number> {
  return page.evaluate((i) => {
    const box = document.querySelector(`[data-page="${i}"]`)?.getBoundingClientRect();
    const view = document.querySelector('.doc-view-scroll')?.getBoundingClientRect();
    if (!box || !view || box.height === 0) return 0;
    const shown = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
    return Math.max(0, shown) / box.height;
  }, index);
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('Next and Previous page step through the document and stop at the ends', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const jump = page.getByRole('textbox', { name: 'Go to page' });
    // The canvas pill's buttons; the ribbon has commands with the same names.
    const pill = page.locator('.canvas-pill');
    const previous = pill.getByRole('button', { name: 'Previous page' });
    const next = pill.getByRole('button', { name: 'Next page' });
    await expect(jump).toHaveValue('1');
    await expect(page.locator('.canvas-pill-total')).toHaveText('/ 5');
    await expect(previous).toBeDisabled();

    await next.click();
    await expect(jump).toHaveValue('2');
    await next.click();
    await expect(jump).toHaveValue('3');
    await previous.click();
    await expect(jump).toHaveValue('2');

    // The last page: Next is off, and the last page is on screen.
    await jump.fill('5');
    await jump.press('Enter');
    await expect(jump).toHaveValue('5');
    await expect(next).toBeDisabled();
    await expect.poll(() => visibleShare(page, 4)).toBeGreaterThan(0);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Go to page jumps to the typed page and refuses a page that does not exist', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const jump = page.getByRole('textbox', { name: 'Go to page' });
    await jump.fill('4');
    await jump.press('Enter');
    await expect(jump).toHaveValue('4');
    await expect.poll(() => visibleShare(page, 3)).toBeGreaterThan(0);
    await expect.poll(() => visibleShare(page, 0)).toBe(0);

    // A page past the end is refused with a message, and the field keeps what was typed.
    await jump.fill('9');
    await jump.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'no page "9"' })).toBeVisible();
    await expect(jump).toHaveValue('9');

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Back and Forward return to the pages the reader came from', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const jump = page.getByRole('textbox', { name: 'Go to page' });
    // The status bar's Back and Forward. History records the jumps the side panels make (the
    // thumbnails, bookmarks, search and redaction lists); the Go to Page field does not record.
    const status = page.locator('.doc-status');
    const back = status.getByRole('button', { name: 'Back', exact: true });
    const forward = status.getByRole('button', { name: 'Forward', exact: true });
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    // The Thumbnails panel is open on a new document; its items are the jump targets.
    const thumbnail = (n: number) => page.getByRole('button', { name: `Go to page ${n} of 5` });
    await expect(thumbnail(3)).toBeVisible();
    await thumbnail(3).click();
    await expect(jump).toHaveValue('3');
    await thumbnail(5).click();
    await expect(jump).toHaveValue('5');
    await expect(back).toBeEnabled();

    await back.click();
    await expect(jump).toHaveValue('3');
    await back.click();
    await expect(jump).toHaveValue('1');
    await expect(back).toBeDisabled();
    await expect(forward).toBeEnabled();

    await forward.click();
    await expect(jump).toHaveValue('3');
    await forward.click();
    await expect(jump).toHaveValue('5');
    await expect(forward).toBeDisabled();

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a document with page labels is paged by its labels', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'page_labels.pdf', fixture('page_labels.pdf'));

    // The field shows the first page's label (roman "i"), and the total is still the page count.
    const jump = page.getByRole('textbox', { name: 'Go to page' });
    await expect(jump).toHaveValue('i');
    await expect(page.locator('.canvas-pill-total')).toHaveText('/ 8');

    // The label "A-2" is the fourth page; the field takes the label, not the page number.
    await jump.fill('A-2');
    await jump.press('Enter');
    await expect(jump).toHaveValue('A-2');
    await expect.poll(() => visibleShare(page, 3)).toBeGreaterThan(0);

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
