// W8.1 S6: links (W5.3). A goto link on a rotated page sits on its text and moves the view; a longer
// jump is recorded and Back returns; a web link asks first in the confirm dialog, and Cancel or Open
// decide what happens; the refused links show their notice and open nothing; axe checks the link
// layer and the dialog. The flows only read the document, so nothing is saved and no host
// check is recorded (as text.spec.ts). window.open is stubbed to log its arguments and open nothing,
// so the run makes no third-party request.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { checkAxe } from './axe';
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

  test('a goto link on a rotated page sits on its text and moves the view to page 2', async ({
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

    // A move of one page is not recorded in the history (navigation.ts recordJump, W5.3 design
    // question 3), so a link to the next page leaves Back off. The next test covers Back.
    const back = page.locator('.doc-status').getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeDisabled();

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a goto link jumps to page iv, and Back returns to page i', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'outline.pdf', fixture('outline.pdf'));

    // outline.pdf numbers its pages in roman, so the field and the link name show the labels.
    const jump = page.getByRole('textbox', { name: 'Go to page' });
    await expect(jump).toHaveValue('i');
    const back = page.locator('.doc-status').getByRole('button', { name: 'Back', exact: true });
    await expect(back).toBeDisabled();

    await page
      .locator('[data-page="0"] .page-link-layer')
      .getByRole('link', { name: 'Go to page iv', exact: true })
      .click();
    await expect(jump).toHaveValue('iv');

    await back.click();
    await expect(jump).toHaveValue('i');
    await expect(back).toBeDisabled();

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

  // The accessibility line (#554): axe on the document with its link layer, then with the confirm
  // dialog open.
  test('axe: the link layer and the confirm dialog @a11y', async ({ page }, testInfo) => {
    const problems = watchPage(page);
    await stubWindowOpen(page);
    await openApp(page);
    await openPdf(page, 'outline.pdf', fixture('outline.pdf'));

    const link = page.getByRole('link', { name: 'Link to example.org', exact: true });
    await expect(link).toBeVisible();
    await checkAxe(page, testInfo);

    await link.click();
    await expect(page.getByRole('dialog', { name: 'Open link?' })).toBeVisible();
    await checkAxe(page, testInfo);

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

    // Page 1's link with an empty destination: MuPDF reports it as a named action, so the engine
    // lists it as unsupported (tests/unit/test_webapi_links.py), not as a link with no page. It
    // comes first, so its notice is the first one shown. The no-destination notice has no fixture
    // link; PageLinkLayer.test.tsx and linkTarget.test.ts cover it.
    await expect(jump).toHaveValue('1');
    await page
      .locator('[data-page="0"] .page-link-layer')
      .getByRole('link', { name: 'Unsupported link', exact: true })
      .click();
    await expect(notice).toHaveText('This kind of link does not work in the web version.');

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

    await expect(dialog).toHaveCount(0);
    await expect.poll(() => openLog(page)).toEqual([]);

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
