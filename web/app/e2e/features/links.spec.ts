// W8.1 S6: links (W5.3). A goto link on a rotated page moves the view and Back returns; a web link
// asks first in the confirm dialog, and Cancel or Open decide what happens; the refused links show
// their notice and open nothing. The flows only read the document, so nothing is saved and no host
// check is recorded (as text.spec.ts). window.open is stubbed to log its arguments and open nothing,
// so the run makes no third-party request.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

// The window.open calls the stub logged, one entry per call: its arguments.
async function openLog(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as Window & { __openLog?: unknown[][] }).__openLog ?? []);
}

// Logs window.open instead of opening a window. The stub returns nothing, as a blocked popup does.
async function stubWindowOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const top = window.top as Window & { __openLog?: unknown[][] };
    if (window === window.top) top.__openLog = [];
    Object.defineProperty(window, 'open', {
      configurable: true,
      writable: true,
      value: function stubbedOpen(...args: unknown[]) {
        top.__openLog?.push(args);
        return null;
      },
    });
  });
}

// Whether two boxes share some area. The link boxes are placed from the page's rects, so a rotated
// page's link must still sit on its anchor text.
async function overlaps(a: Locator, b: Locator): Promise<boolean> {
  const [first, second] = await Promise.all([a.boundingBox(), b.boundingBox()]);
  if (first === null || second === null) return false;
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  );
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('a goto link on a rotated page moves the view, and Back returns to page 1', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'links_rotated.pdf', fixture('links_rotated.pdf'));

    const jump = page.getByRole('textbox', { name: 'Go to page' });
    await expect(jump).toHaveValue('1');

    // The link is named for its target, and its box sits on the anchor text line (the rotation
    // check: the link layer and the text layer are placed from the same visible-space rect).
    const link = page
      .locator('.page-link-layer')
      .getByRole('link', { name: 'Go to page 2', exact: true });
    const line = page.locator('[data-page="0"] .page-text-line', { hasText: 'Go to page 2' });
    await expect(line).toBeVisible();
    await expect.poll(() => overlaps(link, line)).toBe(true);

    await link.click();
    await expect(jump).toHaveValue('2');

    const back = page.locator('.doc-status').getByRole('button', { name: 'Back', exact: true });
    await back.click();
    await expect(jump).toHaveValue('1');

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a web link asks first: Cancel opens nothing, Open link opens it once', async ({ page }) => {
    const problems = watchPage(page);
    await stubWindowOpen(page);
    await openApp(page);
    await openPdf(page, 'outline.pdf', fixture('outline.pdf'));

    const link = page.getByRole('link', { name: 'Link to example.org', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Open link?' });

    await link.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This document wants to open a page on example.org.');
    await expect(dialog).toContainText('https://example.org/');

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(link).toBeFocused();
    await expect.poll(() => openLog(page)).toEqual([]);

    await link.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Open link', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => openLog(page))
      .toEqual([['https://example.org/', '_blank', 'noopener,noreferrer']]);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('refused links show their notice and open nothing', async ({ page }) => {
    const problems = watchPage(page);
    await stubWindowOpen(page);
    await openApp(page);
    await openPdf(page, 'links_rotated.pdf', fixture('links_rotated.pdf'));

    const notice = page.locator('.doc-link-notice');
    const dialog = page.getByRole('dialog');
    const jump = page.getByRole('textbox', { name: 'Go to page' });

    // Page 2, top to bottom: the javascript: link, the malformed link, then the Launch link. The
    // first and last share the name "Unsupported link", so they are picked by position; the notice
    // text names the scheme, which checks the pick.
    await jump.fill('2');
    await jump.press('Enter');
    await expect(jump).toHaveValue('2');
    const page2 = page.locator('[data-page="1"] .page-link-layer');

    await page2.locator('.page-link').nth(0).click();
    await expect(notice).toHaveText('This link was not opened: "javascript" links are blocked.');

    await page2.getByRole('link', { name: 'Link (address not valid)', exact: true }).click();
    await expect(notice).toHaveText('This link was not opened: its address is not valid.');

    await page2.locator('.page-link').nth(2).click();
    await expect(notice).toHaveText('This kind of link does not work in the web version.');

    // Page 1's link with no destination.
    await jump.fill('1');
    await jump.press('Enter');
    await expect(jump).toHaveValue('1');
    await page
      .locator('.page-link-layer')
      .getByRole('link', { name: 'Link with no destination', exact: true })
      .click();
    await expect(notice).toHaveText('This link does not lead to a page in this document.');

    await expect(dialog).toHaveCount(0);
    await expect.poll(() => openLog(page)).toEqual([]);

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
