// W8.1 S5: print (W6.5, W1.4 section 11). The Print dialog takes a page scope; Print runs the print
// job and hands its pages to a hidden iframe, one image per page. This spec prints the current page.
// A range of two or more pages does not reach the iframe: the job's reply carries one binary value
// per page, and printWorker.ts reads only the first one (src/print/printWorker.ts), so the job fails
// with an internal error. The spec for that case is a test.fixme below until the worker is fixed. The browser's print dialog cannot
// be driven from a test, so window.print is stubbed in every frame (an init script) and the stub
// logs the page count it was called with, from the iframe's own document.
import { expect, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

interface PrintCall {
  readonly images: number;
}

// The print log lives on the top window; the app's frame and the print iframe both write to it.
type PrintWindow = Window & { __printLog?: PrintCall[] };

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('print the current page: the dialog opens, the job runs, and window.print is called', async ({
    browserName,
    page,
  }) => {
    test.fixme(
      browserName === 'webkit',
      'WebKit: the style-src CSP refuses a stylesheet (console message), so the CSP check fails there; needs an issue',
    );
    const problems = watchPage(page);
    // Stubbed before any page script runs, in the app's frame and in the print iframe alike.
    await page.addInitScript(() => {
      const top = window.top as Window & { __printLog?: unknown[] };
      if (window === window.top) top.__printLog = [];
      Object.defineProperty(window, 'print', {
        configurable: true,
        writable: true,
        value: function stubbedPrint(this: Window) {
          const log = top.__printLog;
          log?.push({ images: this.document.images.length });
        },
      });
    });
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    // The Print item of the main menu opens the dialog, which names the document's pages.
    await page.getByRole('button', { name: 'Main menu' }).click();
    await page.locator('.app-menu-item', { hasText: 'Print…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Print' });
    await expect(dialog).toBeVisible();

    // The current page only: one image in the iframe (the note above says why not more).
    await dialog.getByRole('radio', { name: 'Current page', exact: true }).check();
    await dialog.getByRole('button', { name: 'Print', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The job renders the page, the iframe gets it, and the stub is called once with that one image.
    await expect
      .poll(() => page.evaluate(() => (window as PrintWindow).__printLog ?? []), {
        timeout: 120_000,
      })
      .toEqual([{ images: 1 }]);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  // BLOCKED: printWorker.ts takes the job's reply as one buffer, so a second page fails (see above).
  test.fixme('print a page range of two pages: the iframe gets both images', async () => {
    // Enable with the worker fix: the same flow as above, with the range "1-2", and two images.
  });
});
