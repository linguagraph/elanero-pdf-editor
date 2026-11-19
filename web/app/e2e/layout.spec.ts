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
