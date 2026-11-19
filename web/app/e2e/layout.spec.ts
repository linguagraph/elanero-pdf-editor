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

test('phone width (390 px): no horizontal scroll, left rail hidden, right rail kept', async ({
  page,
}) => {
  await openAtWidth(page, 390, 844);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'phone');
  expect(await horizontalOverflow(page)).toBe(0);
  await expect(page.getByRole('navigation', { name: 'Left rail' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Right rail' })).toBeVisible();
});

test('desktop width (1366 px): no horizontal scroll, both rails shown and panels docked', async ({
  page,
}) => {
  await openAtWidth(page, 1366, 768);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'wide');
  expect(await horizontalOverflow(page)).toBe(0);
  await expect(page.getByRole('navigation', { name: 'Left rail' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Right rail' })).toBeVisible();
  await expect(page.locator('.app-frame')).toHaveAttribute('data-left-rail', 'shown');
});

test('tablet width (800 px): left rail shown, no horizontal scroll', async ({ page }) => {
  await openAtWidth(page, 800, 1024);
  await expect(page.locator('.app-frame')).toHaveAttribute('data-tier', 'tablet');
  expect(await horizontalOverflow(page)).toBe(0);
  await expect(page.getByRole('navigation', { name: 'Left rail' })).toBeVisible();
});

// The rail buttons show icons, with the name as the tooltip and for screen readers. At the real rail
// width each icon must sit inside its button and inside the rail, so no label is cut off.
test('desktop width: every right rail button fits its rail and shows its icon', async ({
  page,
}) => {
  await openAtWidth(page, 1366, 768);
  const rail = page.getByRole('navigation', { name: 'Right rail' });
  const buttons = rail.locator('button');
  await expect(buttons).toHaveCount(4);
  const railBox = await rail.boundingBox();
  // 48 px of rail plus its 1 px border.
  expect(railBox?.width).toBeCloseTo(49, 0);
  for (let i = 0; i < 4; i += 1) {
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
  await expect(page.locator('.app-frame-header [role="tablist"]')).toHaveCount(0);
  await expect(
    page.locator('.app-frame-header .ribbon-collapsed > .ribbon-tabs > button'),
  ).toHaveCount(7);
  expect(await horizontalOverflow(page)).toBe(0);
});

// An open right panel fills the full height of its region, and its list scrolls inside it. No
// document can be opened here (the engine assets are not staged), so the panel markup of the real
// components is put into the frame, and the real stylesheet measures it. This checks the CSS chain
// from the frame down to the list, which is what the panels depend on.
async function mountPanel(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
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
    panelBody.append(make('p', 'thumbs-status', 'Status'), list);
    section.append(header, panelBody);
    panel.append(section);
    for (let i = 0; i < 200; i += 1) {
      const row = make('div');
      row.style.height = '120px';
      list.append(row);
    }
    body.insertBefore(panel, rail);
  });
}

const PANEL_WINDOWS: readonly { width: number; height: number }[] = [
  { width: 1366, height: 768 },
  { width: 1280, height: 500 },
];

for (const { width, height } of PANEL_WINDOWS) {
  test(`panel fills the window height and scrolls its list at ${width}x${height}`, async ({
    page,
  }) => {
    await openAtWidth(page, width, height);
    await mountPanel(page);
    const panel = page.locator('.app-panel-right');
    const list = page.locator('.app-panel-right .panel-fill');
    const viewport = page.viewportSize();
    const panelBox = await panel.boundingBox();
    const listBox = await list.boundingBox();
    if (panelBox === null || listBox === null || viewport === null) throw new Error('no boxes');
    // The panel's bottom edge is the window's bottom edge (no status bar without a document).
    expect(Math.abs(panelBox.y + panelBox.height - viewport.height)).toBeLessThan(1);
    expect(listBox.y + listBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height);
    // The list is the scroller: it holds more than it shows, and it stays inside the panel.
    const scrolls = await list.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(true);
  });
}
