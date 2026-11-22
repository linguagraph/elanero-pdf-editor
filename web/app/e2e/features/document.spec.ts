// W8.5 S5: the document view under the accessibility checks. Axe runs on the open document in both
// schemes; the forced-colours and touch checks run on Chromium (the browser Playwright emulates
// forced colours and touch for fully); reduced motion runs on every features browser. A document
// needs the staged engine (STAGED), so the specs skip without it, as the other engine specs do.
import { expect, type Page, test } from '@playwright/test';
import { checkAxe, KNOWN_TAB_ISSUES } from './axe';
import { fixture, openApp, openPdf, STAGED, watchPage } from './support';

const SCHEMES = ['light', 'dark'] as const;

// Opens the five-page fixture and waits for the document view (the page group names its page).
async function openDocument(page: Page): Promise<void> {
  await openApp(page);
  await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
  await expect(page.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  for (const scheme of SCHEMES) {
    test.describe(`${scheme} scheme`, () => {
      test.use({ colorScheme: scheme });

      test(`axe: document view (${scheme})`, async ({ page }, testInfo) => {
        const problems = watchPage(page);
        await openDocument(page);
        await checkAxe(page, testInfo, KNOWN_TAB_ISSUES);
        expect(problems, 'CSP or page errors').toEqual([]);
      });
    });
  }

  test('reduced motion: no transition or animation over 0.01 s, and no smooth scrolling', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDocument(page);
    // The emulation must really be on, or the computed styles below would prove nothing.
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );

    // Every element of the page, not a sample: a transition on any control fails the check.
    const offenders = await page.evaluate(() => {
      const seconds = (list: string): number[] =>
        list.split(',').map((part) => {
          const value = parseFloat(part);
          return part.trim().endsWith('ms') ? value / 1000 : value;
        });
      const label = (el: Element): string => {
        const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
        return cls ? `${el.tagName.toLowerCase()}.${cls}` : el.tagName.toLowerCase();
      };
      const found: string[] = [];
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const style = getComputedStyle(el);
        const transition = Math.max(...seconds(style.transitionDuration));
        const animation = Math.max(...seconds(style.animationDuration));
        if (transition > 0.01) found.push(`${label(el)} transition-duration ${transition}s`);
        if (animation > 0.01 && style.animationName !== 'none') {
          found.push(`${label(el)} animation-duration ${animation}s`);
        }
        if (style.scrollBehavior === 'smooth') found.push(`${label(el)} scroll-behavior smooth`);
      }
      return found;
    });
    expect(offenders, 'reduced motion overrides').toEqual([]);
  });

  test.describe('Chromium only', () => {
    test.skip(
      ({ browserName }) => browserName !== 'chromium',
      'forced colours and touch emulation are checked on Chromium (Playwright implements them fully there)',
    );

    test('forced colours: the selected tab and the pressed page control keep a visible border', async ({
      page,
    }) => {
      await page.emulateMedia({ forcedColors: 'active' });
      await openDocument(page);
      expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

      const selectedTab = page.locator('.doc-tab[aria-selected="true"]');
      await expect(selectedTab).toBeVisible();
      const tab = await selectedTab.evaluate((el) => {
        const style = getComputedStyle(el);
        return { border: style.borderTopStyle, outline: style.outlineStyle };
      });
      // In forced colours the selected tab must still be marked by a border or an outline.
      expect(
        tab.border !== 'none' || tab.outline !== 'none',
        'forced colours: .doc-tab[aria-selected=true] has no border or outline',
      ).toBe(true);
    });

    test('touch: the document view controls are at least 44 px under a coarse pointer', async ({
      browser,
    }, testInfo) => {
      // A touch context: hasTouch makes the coarse pointer match, as on a phone or tablet.
      const context = await browser.newContext({
        hasTouch: true,
        viewport: { width: 1366, height: 768 },
      });
      const page = await context.newPage();
      try {
        await openDocument(page);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

        // The controls the brief lists: the canvas pill, the document tabs and the view toolbar.
        const selectors = [
          '.canvas-pill button',
          '.canvas-pill input',
          '.doc-tab',
          '.doc-tab-close',
          '.doc-tabs-menu-button',
          '.doc-view-toolbar button',
        ];
        const small: string[] = [];
        for (const selector of selectors) {
          const controls = page.locator(selector);
          const count = await controls.count();
          for (let i = 0; i < count; i++) {
            const control = controls.nth(i);
            if (!(await control.isVisible())) continue;
            const box = await control.boundingBox();
            const name =
              (await control.getAttribute('aria-label')) ?? (await control.textContent());
            const label = (name ?? '').trim().slice(0, 30) || selector;
            if (!box || box.width < 44 || box.height < 44) {
              small.push(
                `touch: "${label}" (${selector}) is ${Math.round(box?.width ?? 0)}×${Math.round(box?.height ?? 0)} px`,
              );
            }
          }
        }
        await testInfo.attach('touch-small-targets.txt', { body: small.join('\n') || 'none' });
        expect(small, 'touch targets under 44 px').toEqual([]);
      } finally {
        await context.close();
      }
    });
  });
});
