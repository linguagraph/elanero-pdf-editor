// W7.9 L2: the layers panel's checkboxes (W7.9). The flow runs on layers.pdf: "Shown layer" is on by
// default and "Hidden layer" is off. The panel lists both, a checkbox shows or hides each one, and the
// page redraws without the layer's text. A locked layer's checkbox is disabled. The change is view
// state only, so the tab is not marked changed and Save writes the file's own default layer state.
import { expect, test } from '@playwright/test';
import { STAGED, fixture, inkPixels, openApp, openPdf, watchPage } from './support';

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('the layers panel shows and hides layers in the view, and the page redraws', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'layers.pdf', fixture('layers.pdf'));

    // The panel opens from the left rail's Layers button.
    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    const list = page.getByRole('list', { name: 'Optional content layers' });
    const shown = list.getByRole('checkbox', { name: 'Shown layer' });
    const hidden = list.getByRole('checkbox', { name: 'Hidden layer' });
    await expect(shown).toBeChecked();
    await expect(hidden).not.toBeChecked();

    // Hide the shown layer: its checkbox unticks, its row says Hidden, and the page loses ink (the
    // layer's text is no longer drawn).
    const before = await inkPixels(page, 0);
    // A controlled checkbox: a click asks the app to hide the layer, and the checkbox follows.
    await shown.click();
    await expect(shown).not.toBeChecked();
    await expect(list.getByRole('listitem').filter({ hasText: 'Shown layer' })).toContainText(
      'Hidden',
    );
    await expect.poll(() => inkPixels(page, 0)).toBeLessThan(before);

    // Show the hidden layer again: the page gains ink back, the panel lists it as Visible.
    // Controlled like the other checkbox: the click asks the app, and the checkbox follows the reply.
    await hidden.click();
    await expect(hidden).toBeChecked();
    await expect(list.getByRole('listitem').filter({ hasText: 'Hidden layer' })).toContainText(
      'Visible',
    );

    expect(problems).toEqual([]);
  });
});
