import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// W4.2a browser check: the region frame at a phone width and a desktop width (W1.6 section 8).
// The page is the production build of the app, served by `vite preview` (see playwright.config.ts),
// so the strict CSP applies to its real stylesheet. No horizontal page scroll at any width, and the
// left rail shows or hides as the breakpoint table says.
import { expect, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

async function openAtWidth(page: import('@playwright/test').Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('.app-frame')).toBeVisible();
}

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// The page area (#app-page-area) is the scroller in the app frame (overflow: auto), so content that
// is too wide scrolls inside it and leaves the document's own scroll width at 0.
async function pageAreaOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const area = document.querySelector('.app-page-area');
    if (area === null) throw new Error('no page area');
    return area.scrollWidth - area.clientWidth;
  });
}

// The start page replaces the rails too (W1.6 section 1), so both rails are hidden there. No document
// can be opened in these checks, so the rails are shown by setting the frame's data-rails, the way
// the app sets it once a document is open.
async function showRails(page: import('@playwright/test').Page) {
  await page.locator('.app-frame').evaluate((el) => el.setAttribute('data-rails', 'shown'));
}

// The start page widths of the #626 design (section 6): 1366, 1100, 800 and 390 px, the 200 %, 150 %
// and 125 % zoom widths of a 1366 px screen (683, 911, 1093), and the WCAG reflow width (320 px).
for (const [width, height] of [
  [1366, 768],
  [1100, 700],
  [1093, 614],
  [911, 512],
  [800, 1024],
  [683, 384],
  [390, 844],
  [320, 640],
] as const) {
  test(`start page at ${width} px: both rails hidden, no horizontal scroll`, async ({ page }) => {
    await openAtWidth(page, width, height);
    await expect(page.locator('.app-frame')).toHaveAttribute('data-rails', 'hidden');
    await expect(page.getByRole('toolbar', { name: 'Left panels' })).toBeHidden();
    await expect(page.getByRole('toolbar', { name: 'Right panels' })).toBeHidden();
    expect(await horizontalOverflow(page)).toBe(0);
    expect(await pageAreaOverflow(page)).toBe(0);
  });
}

// Design section 6: at 768 px and wider the start column is centred in the window (its left and
// right gaps differ by less than a pixel), and it is the 45rem column (720 px at 16 px root size).
// Checking the width too means a collapsed column that happens to be centred does not pass.
for (const [width, height] of [
  [1366, 768],
  [1093, 614],
  [911, 512],
  [800, 1024],
] as const) {
  test(`start page at ${width} px: the column is centred in the window and 720 px wide`, async ({
    page,
  }) => {
    await openAtWidth(page, width, height);
    const column = await page.locator('.start-page').boundingBox();
    const windowWidth = await page.evaluate(() => document.documentElement.clientWidth);
    if (column === null) throw new Error('no start column');
    const leftGap = column.x;
    const rightGap = windowWidth - (column.x + column.width);
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(1);
    expect(Math.abs(column.width - 720)).toBeLessThan(3);
  });
}

// Design section 6: below 768 px the Open file button fills the card's content width.
for (const [width, height] of [
  [683, 384],
  [390, 844],
  [320, 640],
] as const) {
  test(`start page at ${width} px: the Open file button is full width`, async ({ page }) => {
    await openAtWidth(page, width, height);
    const fill = await page.locator('.start-drop').evaluate((el) => {
      const style = getComputedStyle(el);
      return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    });
    const button = await page.locator('.start-open').boundingBox();
    expect(Math.abs((button?.width ?? 0) - fill)).toBeLessThan(1);
  });
}

// Design section 6: the hero logo is drawn from the 256 px image, so it stays sharp at 2x. The
// natural width must cover the 64 CSS px logo at device pixel ratio 2 (128 device px).
test.describe('start page logo at 2x', () => {
  test.use({ deviceScaleFactor: 2 });

  // naturalWidth alone does not depend on the device pixel ratio, so the rendered width is checked too:
  // 64 CSS px from 768 px, 48 CSS px below (the narrow rule in start.css).
  for (const [width, height, cssWidth] of [
    [1366, 768, 64],
    [390, 844, 48],
  ] as const) {
    test(`the hero logo has at least 128 px of image and renders ${cssWidth} CSS px at ${width} px`, async ({
      page,
    }) => {
      await openAtWidth(page, width, height);
      const logo = page.locator('.start-logo');
      await expect(logo).toBeVisible();
      const naturalWidth = await logo.evaluate(async (el) => {
        const image = el as HTMLImageElement;
        await image.decode();
        return image.naturalWidth;
      });
      expect(naturalWidth).toBeGreaterThanOrEqual(128);
      const box = await logo.boundingBox();
      expect(Math.abs((box?.width ?? 0) - cssWidth)).toBeLessThan(1);
    });
  }
});

test('phone width (390 px): no horizontal scroll, left panels rail hidden by the tier', async ({
  page,
}) => {
  await openAtWidth(page, 390, 844);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'phone');
  expect(await horizontalOverflow(page)).toBe(0);
  await showRails(page);
  await expect(page.getByRole('toolbar', { name: 'Left panels' })).toBeHidden();
  await expect(page.getByRole('toolbar', { name: 'Right panels' })).toBeVisible();
});

test('desktop width (1366 px): both rails at their edges, panels docked', async ({ page }) => {
  await openAtWidth(page, 1366, 768);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'wide');
  await showRails(page);
  expect(await horizontalOverflow(page)).toBe(0);
  const left = page.getByRole('toolbar', { name: 'Left panels' });
  const right = page.getByRole('toolbar', { name: 'Right panels' });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  await expect(page.locator('.app-frame')).toHaveAttribute('data-left-rail', 'shown');
  // The left rail sits at the window's left edge, 48 px plus its 1 px border.
  const leftBox = await left.boundingBox();
  expect(leftBox?.x).toBeCloseTo(0, 0);
  expect(leftBox?.width).toBeCloseTo(49, 0);
  const rightBox = await right.boundingBox();
  expect((rightBox?.x ?? 0) + (rightBox?.width ?? 0)).toBeCloseTo(1366, 0);
});

// The left rail's panels, top to bottom (App.tsx renders them in this order).
const LEFT_RAIL_PANELS = [
  'pages',
  'bookmarks',
  'attachments',
  'layers',
  'redactions',
  'search',
  'comments',
];

test('desktop width: the left rail holds seven panels, in order', async ({ page }) => {
  await openAtWidth(page, 1366, 768);
  await showRails(page);
  const buttons = page.getByRole('toolbar', { name: 'Left panels' }).locator('button');
  await expect(buttons).toHaveCount(LEFT_RAIL_PANELS.length);
  for (const [index, panel] of LEFT_RAIL_PANELS.entries()) {
    await expect(buttons.nth(index)).toHaveAttribute('data-panel', panel);
  }
});

test('tablet width (800 px): left rail shown, no horizontal scroll', async ({ page }) => {
  await openAtWidth(page, 800, 1024);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'tablet');
  await showRails(page);
  expect(await horizontalOverflow(page)).toBe(0);
  await expect(page.getByRole('toolbar', { name: 'Left panels' })).toBeVisible();
});

// The rail buttons show icons, with the name as the tooltip and for screen readers. At the real rail
// width each icon must sit inside its button and inside the rail, so no label is cut off.
test('desktop width: every right rail button fits its rail and shows its icon', async ({
  page,
}) => {
  await openAtWidth(page, 1366, 768);
  await showRails(page);
  const rail = page.getByRole('toolbar', { name: 'Right panels' });
  const buttons = rail.locator('button');
  await expect(buttons).toHaveCount(1);
  const railBox = await rail.boundingBox();
  // 48 px of rail plus its 1 px border.
  expect(railBox?.width).toBeCloseTo(49, 0);
  for (let i = 0; i < 1; i += 1) {
    const button = buttons.nth(i);
    const box = await button.boundingBox();
    expect(
      box && railBox && box.x >= railBox.x && box.x + box.width <= railBox.x + railBox.width,
    ).toBe(true);
    const icon = await button.locator('.rail-icon').boundingBox();
    expect(icon && box && icon.x >= box.x && icon.x + icon.width <= box.x + box.width).toBe(true);
    await expect(button.locator('.rail-icon')).toBeVisible();
    await expect(button).toHaveAttribute('title', /.+/);
  }
});

// W4.3c: the ribbon sits under the logo bar, full width. Above the tablet breakpoint it shows the
// tab list; below it, the collapsed form (one row of tabs, groups in popovers).
test('desktop width (1366 px): the ribbon is mounted with its tabs', async ({ page }) => {
  await openAtWidth(page, 1366, 768);
  const ribbon = page.locator('.app-frame-header .ribbon');
  await expect(ribbon).toBeVisible();
  await expect(ribbon.getByRole('tablist').getByRole('tab')).toHaveCount(7);
  await expect(ribbon.getByRole('tab', { name: 'Home' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBe(0);
});

test('phone width (390 px): the ribbon shows the collapsed form, no horizontal page scroll', async ({
  page,
}) => {
  await openAtWidth(page, 390, 844);
  await expect(page.locator('.app-frame-header .ribbon-collapsed')).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Open documents' })).toHaveCount(0);
  await expect(
    page.locator('.app-frame-header .ribbon-collapsed > .ribbon-tabs > button'),
  ).toHaveCount(7);
  expect(await horizontalOverflow(page)).toBe(0);
});

// An open right panel fills the full height of its region, and its list scrolls inside it. No
// document can be opened here (the engine assets are not staged), so the panel markup of the real
// components is put into the frame, and the real stylesheet measures it. This checks the CSS chain
// from the frame down to the list, which is what the panels depend on.
// `tallBlock` adds a block that is taller than the panel and is not the list (a status or form
// block in a real panel), to check that the panel body scrolls it.
async function mountPanel(page: import('@playwright/test').Page, tallBlock = false) {
  await page.evaluate((tall) => {
    // Built with createElement: the page enforces Trusted Types, so innerHTML is not allowed.
    const make = (tag: string, className = '', text = '') => {
      const el = document.createElement(tag);
      if (className !== '') el.className = className;
      if (text !== '') el.textContent = text;
      return el;
    };
    const body = document.querySelector('.app-frame-body');
    const rail = document.querySelector('.app-rail-right');
    if (body === null || rail === null) throw new Error('no frame');
    const panel = make('aside', 'app-panel app-panel-right');
    panel.setAttribute('aria-label', 'Test panel');
    const section = make('section', 'panel');
    const header = make('header', 'panel-header');
    header.append(make('button', 'panel-toggle', 'Pages'), make('button', 'panel-close', 'x'));
    const panelBody = make('div', 'panel-body');
    const list = make('div', 'thumbs-scroll panel-fill');
    const status = make('p', 'thumbs-status', 'Status');
    if (tall) {
      status.style.height = '1200px';
      panelBody.append(status, make('p', 'thumbs-status', 'Last line'));
    } else {
      panelBody.append(status, list);
      for (let i = 0; i < 200; i += 1) {
        const row = make('div');
        row.style.height = '120px';
        list.append(row);
      }
    }
    section.append(header, panelBody);
    panel.append(section);
    body.insertBefore(panel, rail);
  }, tallBlock);
}

// The window cases: docked at the wide tier, docked at a short window, and the overlay state of the
// medium tier (the frame sets data-right-panel='overlay', and the panel floats over the page area).
const PANEL_CASES: readonly { name: string; width: number; height: number; overlay: boolean }[] = [
  { name: 'docked, 1366x768', width: 1366, height: 768, overlay: false },
  { name: 'docked, short window 1280x500', width: 1280, height: 500, overlay: false },
  { name: 'overlay, 1100x600', width: 1100, height: 600, overlay: true },
];

for (const { name, width, height, overlay } of PANEL_CASES) {
  test(`panel fills the window height and its list scrolls (${name})`, async ({ page }) => {
    await openAtWidth(page, width, height);
    await mountPanel(page);
    if (overlay) {
      await page
        .locator('.app-frame')
        .evaluate((el) => el.setAttribute('data-right-panel', 'overlay'));
    }
    const panel = page.locator('.app-panel-right');
    const list = page.locator('.app-panel-right .panel-fill');
    const viewport = page.viewportSize();
    const panelBox = await panel.boundingBox();
    const listBox = await list.boundingBox();
    if (panelBox === null || listBox === null || viewport === null) throw new Error('no boxes');
    // Without a document there is no status bar, so the window's bottom edge is the panel's.
    expect(Math.abs(panelBox.y + panelBox.height - viewport.height)).toBeLessThan(1);
    // The list reaches the panel's bottom edge less the body's bottom padding.
    const padding = await page
      .locator('.app-panel-right .panel-body')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(
      Math.abs(listBox.y + listBox.height - (panelBox.y + panelBox.height - padding)),
    ).toBeLessThan(1.5);
    // The list is the scroller: it holds more than it shows.
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  });
}

test('a tall block that is not the list scrolls in the panel body at 1280x500', async ({
  page,
}) => {
  await openAtWidth(page, 1280, 500);
  await mountPanel(page, true);
  const body = page.locator('.app-panel-right .panel-body');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByText('Last line')).toBeInViewport();
});

// W4.3a S2: the ribbon's form follows the width (W1.6 section 8). Collapsed at the tablet tier
// (768 to 1023 px), compact at the medium tier (1024 to 1279 px), full from 1280 px.
const RIBBON_FORMS: ReadonlyArray<[number, string]> = [
  [800, 'collapsed'],
  [1023, 'collapsed'],
  [1024, 'compact'],
  [1279, 'compact'],
  [1280, 'full'],
  [1366, 'full'],
];

for (const [width, form] of RIBBON_FORMS) {
  test(`ribbon at ${width} px takes the ${form} form`, async ({ page }) => {
    await openAtWidth(page, width, 768);
    await expect(page.locator('.app-frame-header .ribbon')).toHaveAttribute('data-form', form);
  });
}

for (const width of [390, 800, 1023, 1024, 1279, 1280]) {
  test(`ribbon forms at ${width} px: no horizontal page scroll`, async ({ page }) => {
    await openAtWidth(page, width, 768);
    expect(await horizontalOverflow(page)).toBe(0);
  });
}

// W4.2a S7a: the document tabs sit in the top bar, and below 1024 px they are a drop-down. Opening
// a document needs the staged engine (scripts/stage_engine_assets.mjs), so the check skips without it.
const ENGINE_STAGED = existsSync(
  fileURLToPath(new URL('../public/engine-assets/pyodide.mjs', import.meta.url)),
);

const ONE_PAGE_PDF =
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj\n' +
  'trailer << /Root 1 0 R >>\n%%EOF\n';

test.describe('document tabs in the top bar', () => {
  test.skip(
    !ENGINE_STAGED,
    'engine assets are not staged (scripts/stage_engine_assets.mjs); not run',
  );

  test('tabs are in the header at 1366 px, and a drop-down at 800 px with no horizontal scroll', async ({
    page,
  }) => {
    await openAtWidth(page, 1366, 768);
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'layout.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from(ONE_PAGE_PDF),
      });
    await expect(page.getByRole('tab', { name: /layout\.pdf/ })).toBeVisible({ timeout: 180_000 });
    await expect(page.getByRole('tablist', { name: 'Open documents' })).toHaveCount(1);

    await page.setViewportSize({ width: 800, height: 1024 });
    await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'tablet');
    await expect(page.getByRole('tablist', { name: 'Open documents' })).toHaveCount(0);
    await expect(page.locator('.app-frame-header .doc-tabs-menu-button')).toContainText(
      'layout.pdf',
    );
    expect(await horizontalOverflow(page)).toBe(0);
  });
});
