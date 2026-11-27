// Opens Preferences the way a user does now: Main menu, then its Preferences item. The top bar has
// no Preferences button since the top-chrome change (#795), so the specs share this one path.
import { expect, type Locator, type Page } from '@playwright/test';

export async function openPreferences(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Main menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Preferences…', exact: true }).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  return dialog;
}
