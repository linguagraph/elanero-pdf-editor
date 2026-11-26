// W8.1 S3: zoom and the fit modes on text_multipage (five A4 pages). The zoom box, the steps, the
// presets and the two fit buttons are read through the canvas pill and the status bar. Fit Page
// must leave the whole page on screen, which a page rendered at the wrong size would not. Read-only.
import { expect, type Page, test } from '@playwright/test';
import { fixture, inkPixels, openApp, openPdf, STAGED, watchPage } from './support';

// The first page's box and the scroll area's box, in CSS pixels.
function pageAndView(page: Page): Promise<{ w: number; h: number; viewW: number; viewH: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-page="0"]')?.getBoundingClientRect();
    const view = document.querySelector('.doc-view-scroll')?.getBoundingClientRect();
    return {
      w: box?.width ?? 0,
      h: box?.height ?? 0,
      viewW: view?.width ?? 0,
      viewH: view?.height ?? 0,
    };
  });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('zoom steps, a typed zoom and the presets change the page size', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const zoomText = page.locator('.doc-status-zoom');
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    const zoomBox = page.getByRole('textbox', { name: 'Zoom', exact: true });

    // The start zoom depends on the device pixel ratio, so the steps are checked against it.
    const percent = async () => Number((await zoomText.textContent())?.replace('%', ''));
    const start = await percent();
    const startWidth = (await pageAndView(page)).w;
    await zoomIn.click();
    await expect.poll(percent).toBeGreaterThan(start);
    await expect.poll(async () => (await pageAndView(page)).w).toBeGreaterThan(startWidth);
    await zoomOut.click();
    await zoomOut.click();
    await expect.poll(percent).toBeLessThan(start);

    // A typed percentage is applied on Enter, and the page is painted at that size.
    await zoomBox.fill('50');
    await zoomBox.press('Enter');
    await expect(zoomText).toHaveText('50%');
    await expect.poll(() => inkPixels(page, 0)).toBeGreaterThan(0);

    // A zoom that is not a number or a preset is refused with a message.
    await zoomBox.fill('large');
    await zoomBox.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'not a zoom' })).toBeVisible();

    // A preset from the list sets the zoom to 100 %.
    await page.getByRole('button', { name: 'Zoom presets' }).click();
    await page.locator('.canvas-pill-presets').getByRole('button', { name: '100%' }).click();
    await expect(zoomText).toHaveText('100%');

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('Fit Page shows the whole first page, and Fit Width fills the width', async ({ page }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const pill = page.locator('.canvas-pill');
    const fitPage = pill.getByRole('button', { name: 'Fit page', exact: true });
    const fitWidth = pill.getByRole('button', { name: 'Fit width', exact: true });

    await fitPage.click();
    await expect(fitPage).toHaveAttribute('aria-pressed', 'true');
    await expect(fitWidth).toHaveAttribute('aria-pressed', 'false');
    // The whole page fits inside the scroll area, both ways (one pixel of rounding allowed).
    await expect
      .poll(async () => {
        const size = await pageAndView(page);
        return size.h > 0 && size.h <= size.viewH + 1 && size.w <= size.viewW + 1;
      })
      .toBe(true);
    await expect.poll(() => inkPixels(page, 0)).toBeGreaterThan(0);

    await fitWidth.click();
    await expect(fitWidth).toHaveAttribute('aria-pressed', 'true');
    await expect(fitPage).toHaveAttribute('aria-pressed', 'false');
    // Fit Width: the page spans most of the area's width (the gutter takes the rest).
    await expect
      .poll(async () => {
        const size = await pageAndView(page);
        return size.w / size.viewW;
      })
      .toBeGreaterThan(0.7);

    // A manual zoom leaves the fit mode.
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(fitWidth).toHaveAttribute('aria-pressed', 'false');

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('the View ribbon has no Rotate View, and no button is off because it is not available yet', async ({
    page,
  }) => {
    // #735: Rotate View did nothing on the web. The page-step buttons are off on page 1 and Back and
    // Forward have no history yet; those are off for their own reasons, so only the reason text is checked.
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
    await page.getByRole('tab', { name: 'View', exact: true }).click();

    const buttons = await page.locator('.ribbon-panel:visible [data-command]').evaluateAll((els) =>
      els.map((el) => ({
        id: el.getAttribute('data-command'),
        off: el.getAttribute('aria-disabled') === 'true',
        text: (el.getAttribute('aria-describedby') ?? '')
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      })),
    );
    const ids = buttons.map((button) => button.id);
    expect(ids).toContain('night-reading');
    expect(ids).toContain('zoom-in');
    expect(ids).not.toContain('rotate-view-clockwise');
    expect(ids).not.toContain('rotate-view-counterclockwise');
    expect(buttons.find((button) => button.id === 'zoom-in')?.off).toBe(false);
    expect(buttons.filter((button) => button.text.includes('not available yet'))).toEqual([]);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('single page: the page shown after steps renders, without scrolling the others (#734)', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    // Switch to Single page from the palette, then step to page 4 (index 3) with Next Page. No
    // scrolling, so the pages before it are never on screen.
    const runCommand = async (query: string, id: string): Promise<void> => {
      await page.getByRole('searchbox', { name: 'Search tools' }).fill(query);
      await page.locator(`.palette-row[data-command="${id}"]`).click();
    };
    await runCommand('Single', 'single-page');
    for (let step = 0; step < 3; step += 1) {
      await runCommand('Next', 'next-page');
    }

    // Only the shown page is mounted, and its canvas is painted (not blank).
    await expect(page.locator('.doc-page')).toHaveCount(1);
    await expect(page.locator('[data-page="3"]')).toBeVisible();
    await expect.poll(() => inkPixels(page, 3)).toBeGreaterThan(0);

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
