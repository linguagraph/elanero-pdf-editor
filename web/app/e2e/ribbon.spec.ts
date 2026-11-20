// W4.3a S3 browser check: the ribbon's group overflow (W1.6 section 2). At the widths where the
// row is too narrow for a tab's groups, the groups that do not fit move to the "More commands"
// menu, whole and in order, and the page does not scroll sideways. The ribbon shows on the start
// page, so no document is needed.
import { expect, type Locator, type Page, test } from '@playwright/test';

test.use({ baseURL: process.env.E2E_APP_URL ?? 'http://localhost:4174' });

const TABS = ['Home', 'Edit', 'Organize', 'Protect', 'Comment', 'View', 'Tools'];

async function openAtWidth(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await expect(page.locator('.app-frame')).toBeVisible();
}

async function selectTab(page: Page, name: string): Promise<Locator> {
  const tab = page.locator('.ribbon [role="tab"]', { hasText: name });
  await tab.click();
  return page.locator('.ribbon-panel');
}

// The ids of the groups in a locator's group list, in order.
async function groupIds(locator: Locator): Promise<string[]> {
  return locator.evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.group ?? ''),
  );
}

// Every group the tab has, from a window wide enough that nothing moves to the menu.
async function allGroupIds(page: Page, name: string): Promise<string[]> {
  await page.setViewportSize({ width: 1920, height: 800 });
  const panel = await selectTab(page, name);
  await expect(page.locator('.ribbon-more')).toHaveCount(0);
  return groupIds(panel.locator('.ribbon-toolbar > [data-group]'));
}

for (const width of [1024, 1280]) {
  test(`at ${width} px every tab keeps its groups in the row or in the menu, in order`, async ({
    page,
  }) => {
    await openAtWidth(page, 1920);
    const expected: Record<string, string[]> = {};
    for (const name of TABS) expected[name] = await allGroupIds(page, name);

    await page.setViewportSize({ width, height: 800 });
    for (const name of TABS) {
      const panel = await selectTab(page, name);
      const row = panel.locator('.ribbon-toolbar > [data-group]');
      const rowIds = await groupIds(row);

      // Each group in the row lies wholly inside the panel.
      const panelBox = await panel.boundingBox();
      expect(panelBox).not.toBeNull();
      for (let i = 0; i < (await row.count()); i += 1) {
        const box = await row.nth(i).boundingBox();
        expect(box).not.toBeNull();
        if (box === null || panelBox === null) continue;
        expect(box.x).toBeGreaterThanOrEqual(panelBox.x - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      }

      // The row's groups and the menu's groups, in order, are the tab's groups.
      const more = panel.locator('.ribbon-more');
      let menuIds: string[] = [];
      if ((await more.count()) > 0) {
        await more.click();
        menuIds = await groupIds(page.locator('[role="dialog"] [data-group]'));
        await page.keyboard.press('Escape');
        await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      }
      expect([...rowIds, ...menuIds]).toEqual(expected[name]);

      // Organize overflows at 1280 px (measured: 4 of 5 groups in the row, 1 in the menu), so the
      // check cannot pass by moving nothing. Home never overflows in the measured widths.
      if (name === 'Organize' && width === 1280) {
        expect(rowIds.length).toBeLessThan((expected[name] ?? []).length);
        await expect(more).toBeVisible();
        expect(menuIds.length).toBeGreaterThan(0);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    }
  });
}

test('at 1920 px no tab shows the "More commands" button', async ({ page }) => {
  await openAtWidth(page, 1920);
  for (const name of TABS) {
    await selectTab(page, name);
    await expect(page.locator('.ribbon-more')).toHaveCount(0);
  }
});
