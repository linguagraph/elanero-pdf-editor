// W8.5 S4: the keyboard walkthrough on the screens that open with no document. Tab order and focus
// visibility on the ribbon, the page area and the dialogs; F6 region cycling; focus returning to its
// opener when a dialog closes. Each step reads the focus after the key press, so a lost focus (on
// BODY) or an invisible ring fails at the key press that caused it. The start page and its dialogs
// need no engine, so these run on every features browser. The document's own regions (the rails,
// the panels, the status bar) and Open and Save need the staged engine (STAGED) and are not here yet.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectFocusWithin, expectVisibleFocus, focusInfo, type FocusInfo, tabWalk } from './focus';

// WebKit does not put links in the Tab order by default (the macOS "tab to links" setting, which
// Playwright's WebKit inherits). The skip link is still focusable, and the Tab walk covers the rest.
const WEBKIT_LINKS =
  'WebKit: links are not in the Tab order by default, so Tab cannot reach the skip link';

function linksTabbableHere(): boolean {
  return test.info().project.name !== 'webkit';
}

function sameStop(stop: FocusInfo, other: FocusInfo | undefined): boolean {
  return other !== undefined && stop.target === other.target && stop.name === other.name;
}

async function openStartPage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.start-page')).toBeVisible();
}

// Moves the focus to a control by Tab from the top of the page, so the test starts where a
// keyboard user does rather than from a programmatic focus call.
async function tabTo(page: Page, control: Locator, limit = 30): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await control.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab did not reach the control within ${limit} presses`);
}

test('Tab order: the skip link comes first, then the ribbon, then the page; every stop has a ring', async ({
  page,
}) => {
  await openStartPage(page);
  // One lap ends when the focus leaves the page. Chromium passes through BODY on the way; Firefox
  // wraps to the first stop, or keeps the last stop focused while the browser's own chrome has the
  // Tab key. Each of those ends the lap.
  const stops = await tabWalk(page, 40);
  const first = stops[0];
  const end = stops.findIndex(
    (stop, i) => i > 0 && (stop.onBody || sameStop(stop, first) || sameStop(stop, stops[i - 1])),
  );
  expect(end, 'Tab never completed a lap in 40 presses').toBeGreaterThan(0);
  const walk = stops.slice(0, end);

  if (linksTabbableHere()) expect(walk[0]?.target).toContain('app-skip-link');
  const regions = walk.map((stop) => stop.region);
  // Ribbon stops come before any page stop, and the page area is reached.
  const firstPage = regions.indexOf('page');
  expect(firstPage, 'the page area is never reached by Tab').toBeGreaterThan(0);
  expect(regions.slice(0, firstPage).every((r) => r === 'ribbon' || r === '-')).toBe(true);
  for (const [i, stop] of walk.entries()) {
    expect(stop.ringed, `Tab stop ${i + 1} ${stop.target} "${stop.name}" has no visible ring`).toBe(
      true,
    );
  }
});

test('the skip link moves the focus to the document', async ({ page }) => {
  test.skip(!linksTabbableHere(), WEBKIT_LINKS);
  await openStartPage(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.app-skip-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app-page-area')).toBeFocused();
  await expectVisibleFocus(page, 'after the skip link');
});

test('F6 cycles the regions on the start page and never drops the focus', async ({ page }) => {
  await openStartPage(page);
  await tabTo(page, page.getByRole('button', { name: 'Main menu' }));
  await expectVisibleFocus(page, 'Main menu');
  expect((await focusInfo(page)).region).toBe('ribbon');

  await page.keyboard.press('F6');
  await expectVisibleFocus(page, 'F6 to the page');
  expect((await focusInfo(page)).region).toBe('page');

  await page.keyboard.press('F6');
  await expectVisibleFocus(page, 'F6 back to the ribbon');
  expect((await focusInfo(page)).region).toBe('ribbon');

  await page.keyboard.press('Shift+F6');
  await expectVisibleFocus(page, 'Shift+F6 to the page');
  expect((await focusInfo(page)).region).toBe('page');
});

test('the ribbon tabs move with the arrow keys, and Tab leaves them for the search box', async ({
  page,
}) => {
  await openStartPage(page);
  await page.locator('.ribbon-tab').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.ribbon-tab', { hasText: 'Edit' })).toBeFocused();
  await expectVisibleFocus(page, 'ArrowRight on the ribbon tabs');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('searchbox', { name: 'Search tools' })).toBeFocused();
});

test('the main menu opens with the focus on its first item, and Esc returns it to the button', async ({
  page,
}) => {
  await openStartPage(page);
  const menu = page.getByRole('button', { name: 'Main menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  const first = page.locator('.app-menu-item').first();
  await expect(first).toBeFocused();
  // react-aria sets the focus-visible flag a frame after the focus, so wait for it before the ring check.
  await expect(first).toHaveAttribute('data-focus-visible', 'true');
  await expectVisibleFocus(page, 'main menu opened');
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
});

test('Preferences: Tab stays inside the dialog, F6 does nothing, Esc returns the focus', async ({
  page,
}) => {
  await openStartPage(page);
  const opener = page.getByRole('button', { name: 'Preferences…', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();

  for (let i = 1; i <= 30; i++) {
    await page.keyboard.press('Tab');
    await expectFocusWithin(page, dialog, `Tab ${i} in Preferences`);
    await expectVisibleFocus(page, `Tab ${i} in Preferences`);
  }

  await page.keyboard.press('F6');
  await expectFocusWithin(page, dialog, 'F6 inside Preferences');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('nested dialog: Esc closes Keyboard Shortcuts first, then Preferences; focus follows the opener', async ({
  page,
}) => {
  await openStartPage(page);
  await page.getByRole('button', { name: 'Preferences…', exact: true }).click();
  const prefs = page.getByRole('dialog').first();
  await expect(prefs).toBeVisible();
  const shortcutsButton = page.getByRole('button', { name: 'Keyboard Shortcuts…', exact: true });
  await shortcutsButton.focus();
  await page.keyboard.press('Enter');
  const shortcuts = page.getByRole('dialog').last();
  await expect(shortcuts).toBeVisible();
  await expectFocusWithin(page, shortcuts, 'Keyboard Shortcuts opened');

  // `.last()` is lazy: after Esc it would name Preferences, so the count is what proves the close.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(prefs).toBeVisible();
  await expect(shortcutsButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(prefs).toBeHidden();
});

test('the command palette: Esc returns the focus to the ribbon search box', async ({ page }) => {
  await openStartPage(page);
  const search = page.getByRole('searchbox', { name: 'Search tools' });
  await search.click();
  await page.keyboard.type('a');
  const palette = page.getByRole('dialog').first();
  await expect(palette).toBeVisible();
  await expectFocusWithin(page, palette, 'palette opened by typing');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  await expect(search).toBeFocused();
});
