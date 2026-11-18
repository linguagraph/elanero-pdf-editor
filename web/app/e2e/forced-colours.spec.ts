// W4.4a browser check: the app under forced colours (Windows high contrast). The page is the
// production build, served by `vite preview` (see playwright.config.ts), so the strict CSP and the
// real stylesheet apply. The header keeps its text and the focus ring stays visible.
import { expect, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

for (const colorScheme of ['light', 'dark'] as const) {
  test(`forced colours (${colorScheme}): header text and focus ring stay visible`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme, forcedColors: 'active' });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    // The emulation must really be on, or the checks below would prove nothing.
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(page.locator('.app-frame')).toBeVisible();

    // The brand image (or its wordmark fallback) and the Preferences button are in the header.
    const logo = page.locator('.app-header img.brand-logo');
    await expect(logo).toBeVisible();
    await expect(logo).toHaveAttribute('alt', 'Elanero logo');
    const preferences = page.locator('.app-header').getByRole('button', { name: 'Preferences' });
    await expect(preferences).toBeVisible();

    // Keyboard focus (Tab) on the theme choice, so :focus-visible applies as it does for a user.
    const system = page.getByRole('radio', { name: 'System' });
    for (
      let i = 0;
      i < 30 && !(await system.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab');
    }
    await expect(system).toBeFocused();

    // The focus ring is drawn on the option label, which has an outline in forced colours.
    const outline = await system.evaluate((input) => {
      const label = input.closest('label');
      if (!label) return null;
      const style = getComputedStyle(label);
      return {
        focusVisible: input.matches(':focus-visible'),
        style: style.outlineStyle,
        width: style.outlineWidth,
      };
    });
    expect(outline).not.toBeNull();
    expect(outline?.focusVisible).toBe(true);
    expect(outline?.style).toBe('solid');
    expect(outline?.width).toBe('2px');
  });
}
