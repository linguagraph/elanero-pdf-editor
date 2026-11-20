// W8.1 S4: search (W5.4). The Search panel finds a word, the count reads "1 of N matches", Next
// and Previous step through the hits, and the view scrolls to the current hit. The flow only reads
// the document, so nothing is saved and no host check is recorded. text_multipage has the word
// "needle" once on each of its five pages, so the hits are on pages 1 to 5.
import { expect, type Page, test } from '@playwright/test';
import { STAGED, fixture, openApp, openPdf, watchPage } from './support';

// Whether the current hit's mark is inside the viewport. The mark is drawn on its page, so it is in
// view only when the view has scrolled to the hit.
async function currentMarkInView(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const mark = document.querySelector('.search-mark--current');
    if (mark === null) return false;
    const box = mark.getBoundingClientRect();
    return box.bottom > 0 && box.top < window.innerHeight;
  });
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test('find a word: the count, the next and previous matches, and the view follows them', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    // The Search rail button opens the panel; its query box is a search field.
    await page.locator('[data-panel="search"]').click();
    const query = page.getByRole('searchbox', { name: 'Search text' });
    await query.fill('needle');
    await query.press('Enter');

    // The first hit is the first of the five, and the count names it: "1 of 5 matches".
    const status = page.locator('.search-status');
    await expect(status).toHaveText('1 of 5 matches');
    const results = page.getByRole('list', { name: 'Search results' });
    await expect(results.getByRole('button')).toHaveCount(5);
    await expect.poll(() => currentMarkInView(page)).toBe(true);

    // Next match: the count moves on, and the view scrolls to that hit.
    const next = page.getByRole('button', { name: 'Next match', exact: true });
    await next.click();
    await expect(status).toHaveText('2 of 5 matches');
    await expect.poll(() => currentMarkInView(page)).toBe(true);

    // Next from the last hit wraps to the first, and the view follows it back.
    for (let step = 0; step < 4; step += 1) await next.click();
    await expect(status).toHaveText('1 of 5 matches');
    await expect.poll(() => currentMarkInView(page)).toBe(true);

    // Previous match wraps to the last hit, on page 5, and the view follows it there.
    await page.getByRole('button', { name: 'Previous match', exact: true }).click();
    await expect(status).toHaveText('5 of 5 matches');
    await expect.poll(() => currentMarkInView(page)).toBe(true);

    // A word with no hits says so.
    await query.fill('zzqqxx');
    await query.press('Enter');
    await expect(status).toHaveText('No matches.');

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
