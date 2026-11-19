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
