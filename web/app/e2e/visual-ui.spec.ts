// W8.2 S4 (docs/web/design/W8.2-visual-golden.md, section 3): screenshots of five web screens in
// light and dark, compared with the references in tests/golden/web/linux (Chromium on Linux only,
// since the font rasterising differs by OS). The references come from a dispatch run of web-e2e
// with update_snapshots=true, never from a developer machine (D6). Needs the staged engine and
// skips without it, and skips off Linux.
import { existsSync } from 'node:fs';
import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { fixture, inkPixels, openApp, openPdf, STAGED } from './features/support';

// The production build (the layout and feature specs use the same port, playwright.config.ts). The
// default baseURL is the dev harness, which injects its CSS inline and would be blocked by the CSP.
test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const SCHEMES = ['light', 'dark'] as const;
const DOCUMENT = 'text_multipage.pdf';
// The first paint on a cold CI worker can take longer than the default 5 s poll.
const PAINT_TIMEOUT = 30_000;
const UPDATE_HINT =
  'gh workflow run web-e2e.yml --ref <branch> -f update_snapshots=true, then download the ' +
  'web-ui-snapshots artifact into tests/golden/web/linux and commit the PNGs';

// Fails with the dispatch command when the reference is missing. Playwright would otherwise write
// the actual image and fail with its own message, which does not say how to make the reference.
function requireReference(testInfo: TestInfo, name: string): void {
  if (testInfo.config.updateSnapshots === 'all') return;
  const path = testInfo.snapshotPath(name, { kind: 'screenshot' });
  if (!existsSync(path)) throw new Error(`missing UI reference ${path}: ${UPDATE_HINT}`);
}

// Ink pixels of the first canvas matching the selector (opaque, dark pixels, sampled), so the
// screenshot waits until a thumbnail is painted, not blank. The organizer thumbnails are not document
// pages, so inkPixels (which is keyed on a document page index) does not apply to them.
async function thumbnailInk(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector<HTMLCanvasElement>(sel);
    const context = canvas?.getContext('2d');
    if (!canvas || !context || canvas.width === 0) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let offset = 0; offset < pixels.length; offset += 4 * 17) {
      if (pixels[offset]! < 128 && pixels[offset + 3]! >= 128) ink += 1;
    }
    return ink;
  }, selector);
}

// The indexes of the document pages whose canvas overlaps the viewport now.
async function visiblePageIndexes(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas.doc-page-canvas'))
      .filter((canvas) => {
        const box = canvas.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight && box.width > 0;
      })
      .map((canvas) => Number(canvas.closest<HTMLElement>('[data-page]')?.dataset.page))
      .filter((index) => Number.isInteger(index)),
  );
}

// Waits until page 0 and every other document page in the viewport show ink, so a slow page 1 cannot
// be captured blank.
async function waitForVisiblePages(page: Page): Promise<void> {
  await expect.poll(() => visiblePageIndexes(page), { timeout: PAINT_TIMEOUT }).toContain(0);
  for (const index of await visiblePageIndexes(page)) {
    await expect.poll(() => inkPixels(page, index), { timeout: PAINT_TIMEOUT }).toBeGreaterThan(0);
  }
}

// Before a shot: the mouse leaves the page and focus is dropped, so no hover or focus ring shows.
async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

// Runs a command from the command palette by its id (the palette row, not a ribbon button).
async function runCommandById(page: Page, query: string, id: string): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search tools' }).fill(query);
  await page.locator(`.palette-row[data-command="${id}"]`).click();
}

test.describe('engine staged', () => {
  test.skip(
    !STAGED || process.platform !== 'linux',
    'engine assets are not staged, or not Linux (the references are Linux renders); not run',
  );

  for (const scheme of SCHEMES) {
    test.describe(`${scheme} scheme`, () => {
      test.use({
        colorScheme: scheme,
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });

      test(`start page (${scheme}) @visual`, async ({ page }, testInfo) => {
        const name = `start-${scheme}.png`;
        requireReference(testInfo, name);
        await openApp(page);
        await settle(page);
        // The footer carries the app version, which changes with every release.
        await expect(page).toHaveScreenshot(name, { mask: [page.locator('.start-footer')] });
      });

      test(`document view (${scheme}) @visual`, async ({ page }, testInfo) => {
        const name = `document-${scheme}.png`;
        requireReference(testInfo, name);
        await openApp(page);
        await openPdf(page, DOCUMENT, fixture(DOCUMENT));
        await waitForVisiblePages(page);
        await settle(page);
        await expect(page).toHaveScreenshot(name);
      });

      test(`night reading (${scheme}) @visual`, async ({ page }, testInfo) => {
        const name = `night-reading-${scheme}.png`;
        requireReference(testInfo, name);
        await openApp(page);
        await openPdf(page, DOCUMENT, fixture(DOCUMENT));
        await runCommandById(page, 'Night', 'night-reading');
        // The view gets the night class once the command has applied.
        await expect(page.locator('.doc-view--night')).toHaveCount(1);
        await waitForVisiblePages(page);
        await settle(page);
        await expect(page).toHaveScreenshot(name);
      });

      test(`organize pages panel (${scheme}) @visual`, async ({ page }, testInfo) => {
        const name = `organizer-${scheme}.png`;
        requireReference(testInfo, name);
        await openApp(page);
        await openPdf(page, DOCUMENT, fixture(DOCUMENT));
        const rail = page.locator('button.rail-button[title="Organize pages"]');
        if ((await rail.getAttribute('aria-expanded')) !== 'true') await rail.click();
        await expect(rail).toHaveAttribute('aria-expanded', 'true');
        // The thumbnails paint after the panel opens; the first one must show ink.
        await expect
          .poll(
            () => thumbnailInk(page, '.organizer-item[data-page="0"] canvas.organizer-canvas'),
            {
              timeout: PAINT_TIMEOUT,
            },
          )
          .toBeGreaterThan(0);
        await settle(page);
        await expect(page).toHaveScreenshot(name);
      });

      test(`header and footer dialog (${scheme}) @visual`, async ({ page }, testInfo) => {
        const name = `header-footer-${scheme}.png`;
        requireReference(testInfo, name);
        await openApp(page);
        await openPdf(page, DOCUMENT, fixture(DOCUMENT));
        await waitForVisiblePages(page);
        await runCommandById(page, 'Header', 'add-header-footer');
        const dialog = page.getByRole('dialog', { name: 'Header & Footer', exact: true });
        await expect(dialog).toBeVisible();
        await settle(page);
        // The dialog element only, not the page behind it.
        await expect(dialog).toHaveScreenshot(name);
      });
    });
  }
});
