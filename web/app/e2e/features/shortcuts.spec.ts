// W4.x #330 (W3): the editable keyboard shortcuts on the start page, which needs no engine. Preferences
// opens the Keyboard Shortcuts dialog, a key is rebound and used, the binding survives a reload, and
// Reset all puts it back. A browser-reserved key is refused with its message, and the dialog is
// walked with Tab only. The palette's Change shortcuts button opens the same dialog.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { expectFocusWithin } from './focus';

async function openStartPage(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.start-page')).toBeVisible();
}

// Preferences, then its Keyboard Shortcuts button. Returns the nested dialog (the last one).
async function openShortcutsFromPreferences(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Preferences…', exact: true }).click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await page.getByRole('button', { name: 'Keyboard Shortcuts…', exact: true }).click();
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  return dialog;
}

// Ctrl on the desktop, Cmd on macOS: the key the recorder reads as Ctrl (the probe does the same).
function ctrl(chord: string): string {
  return process.platform === 'darwin' ? `Meta+${chord}` : `Control+${chord}`;
}

// The table row for one command. Its button is named by the command, and the row holds its keys.
// The inner locator is rooted at the page: a `has` locator is queried inside the row, where the
// dialog itself is not, so a dialog-rooted inner locator matches no row.
function rowFor(page: Page, dialog: Locator, name: RegExp): Locator {
  return dialog.locator('tr').filter({ has: page.getByRole('button', { name }) });
}

// Records one chord in the recorder for the selected command and returns the recorder.
async function record(
  page: Page,
  dialog: Locator,
  command: string,
  chord: string,
): Promise<Locator> {
  const recorder = dialog.getByRole('button', { name: `Record new shortcut for ${command}` });
  await recorder.click();
  await page.keyboard.press(chord);
  return recorder;
}

test('a rebound key runs its command, survives a reload, and Reset all restores the default', async ({
  page,
}) => {
  await openStartPage(page);
  const dialog = await openShortcutsFromPreferences(page);

  // Open… runs on the start page; rebind it to Ctrl+Alt+O.
  await dialog.getByRole('button', { name: 'Open…', exact: true }).click();
  await record(page, dialog, 'Open…', ctrl('Alt+O'));
  await expect(dialog.getByText(/Press Assign to use it\.$/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(dialog.getByText(/^Open… now uses /)).toBeVisible();

  // Close both dialogs (Escape closes the nested one first), then the new key opens the file chooser.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press(ctrl('Alt+O'));
  await chooser;

  // The binding is stored, so a reload keeps it.
  await page.reload();
  await expect(page.locator('.start-page')).toBeVisible();
  const again = page.waitForEvent('filechooser');
  await page.keyboard.press(ctrl('Alt+O'));
  await again;

  // Reset all asks first, then puts every key back: Open… is Ctrl+O again.
  const restored = await openShortcutsFromPreferences(page);
  await restored.getByRole('button', { name: 'Reset all…', exact: true }).click();
  await restored.getByRole('button', { name: 'Reset all', exact: true }).click();
  await expect(
    rowFor(page, restored, /^Open…$/).getByText('Default', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  const defaultChooser = page.waitForEvent('filechooser');
  await page.keyboard.press(ctrl('O'));
  await defaultChooser;
});

test('a browser-reserved key is refused with its message, and nothing is assigned', async ({
  page,
}) => {
  await openStartPage(page);
  const dialog = await openShortcutsFromPreferences(page);

  await dialog.locator('.shortcut-row-button', { hasText: /^Close$/ }).click();
  await record(page, dialog, 'Close', ctrl('W'));
  await expect(dialog.getByRole('alert')).toHaveText('Your browser uses this key itself.');
  await expect(dialog.getByRole('button', { name: 'Assign', exact: true })).toBeDisabled();
  // The browser's tab was not closed: the page is still here.
  expect(page.isClosed()).toBe(false);
  await expect(dialog).toBeVisible();
});

test('the recorder is not a keyboard trap: Tab leaves it, Escape cancels recording only', async ({
  page,
}) => {
  await openStartPage(page);
  const dialog = await openShortcutsFromPreferences(page);
  await expect(dialog.getByLabel('Filter commands')).toBeFocused();

  const recorder = dialog.getByRole('button', { name: 'Record new shortcut for Open…' });
  await recorder.click();
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button', { name: 'Record new shortcut for Open…' })).toBeVisible();
  await expect(dialog).toBeVisible();

  // Walk the dialog with Tab only: focus stays inside it on every stop.
  await recorder.focus();
  for (let i = 1; i <= 25; i++) {
    await page.keyboard.press('Tab');
    await expectFocusWithin(page, dialog, `Tab ${i} in Keyboard Shortcuts`);
  }
});

test('Change shortcuts in the palette list opens the same dialog', async ({ page }) => {
  await openStartPage(page);
  await page.keyboard.press(ctrl('Shift+P'));
  const palette = page.getByRole('dialog').first();
  await expect(palette).toBeVisible();
  await page.locator('.palette-input').fill('keyboard');
  await page.keyboard.press('Enter');
  await palette.getByRole('button', { name: 'Change shortcuts…', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByLabel('Filter commands')).toBeVisible();
});
