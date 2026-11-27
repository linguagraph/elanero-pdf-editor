// W8.5 S7: touch targets (W8.5 section 2.2, W1.6 section 8). With a document open, every visible
// button, menu item, option, tab, input and select is at least 44 by 44 CSS px under a coarse
// pointer. The sweep covers the document view, each side panel, the app menu, Preferences and one
// engine dialog. Chromium only: Playwright emulates touch fully there. A document needs the staged
// engine (STAGED), so the spec skips without it, as the other engine specs do.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { fixture, openApp, openPdf, STAGED } from './support';
import { openPreferences } from '../harness/openPreferences';

const MIN_PX = 44;

// The controls a touch user taps. Text-layer spans and inline links are not in this list, so the
// sweep never measures them (see EXEMPT).
const TAP_SELECTOR = 'button, [role="menuitem"], [role="option"], [role="tab"], input, select';

// The named exceptions, each with its reason. `inLabel` means the element is skipped only when the
// label that wraps it is at least 44 px square (the label is the target); any other match is skipped.
const EXEMPT: ReadonlyArray<{ what: string; selector: string; inLabel: boolean }> = [
  // The checkbox or radio is drawn at 13 to 20 px, and the labelled row around it is the target
  // (the security checks, the Preferences options). A bare checkbox outside a 44 px label is reported.
  {
    what: 'checkbox and radio inside a labelled row',
    selector: 'input[type="checkbox"], input[type="radio"]',
    inLabel: true,
  },
  // Text-layer spans (.page-text-line) are not tap targets: selection is by dragging, and the
  // selection handles are already 44 px. Not in TAP_SELECTOR; listed so the exception is recorded.
  { what: 'text-layer spans', selector: '.page-text-line', inLabel: false },
  // Inline links in running text are not in TAP_SELECTOR either. Listed for the same reason.
  { what: 'inline links', selector: 'a', inLabel: false },
];

// Returns one line per visible tap target that is smaller than 44 by 44 under `root`.
async function undersized(root: Locator): Promise<string[]> {
  return root.evaluate(
    (node, args) => {
      const out: string[] = [];
      for (const el of Array.from(node.querySelectorAll(args.tapSelector))) {
        if (el.getClientRects().length === 0) continue;
        // Visually hidden helpers keep a 1 px box clipped away; they are not targets.
        if (el.closest('.visually-hidden, .ribbon-visually-hidden')) continue;
        const exempt = args.exempt.find((entry) => el.matches(entry.selector));
        if (exempt) {
          const box = exempt.inLabel ? el.closest('label')?.getBoundingClientRect() : undefined;
          if (!exempt.inLabel || (box && box.width >= args.minPx && box.height >= args.minPx)) {
            continue;
          }
        }
        const rect = el.getBoundingClientRect();
        if (rect.width < args.minPx || rect.height < args.minPx) {
          const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
          const name = text || el.tagName.toLowerCase();
          out.push(
            `"${name}" (${el.tagName.toLowerCase()}) is ${Math.round(rect.width)}x${Math.round(rect.height)} px`,
          );
        }
      }
      return out;
    },
    { tapSelector: TAP_SELECTOR, minPx: MIN_PX, exempt: [...EXEMPT] },
  );
}

// Sweeps one region; a failure names each small control.
async function sweep(root: Locator, area: string): Promise<void> {
  const small = await undersized(root);
  expect(small, `${area}: tap targets under ${MIN_PX} px`).toEqual([]);
}

async function openDocument(page: Page): Promise<void> {
  await openApp(page);
  await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));
  await expect(page.getByRole('group', { name: 'Page 1 of 5' })).toBeVisible();
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');

  test.describe('Chromium only', () => {
    test.skip(
      ({ browserName }) => browserName !== 'chromium',
      'touch emulation is checked on Chromium (Playwright implements it fully there)',
    );
    test.use({ hasTouch: true, isMobile: false, viewport: { width: 1366, height: 768 } });

    test('touch: the document view, side panels, app menu, Preferences and a dialog are 44 px @a11y', async ({
      page,
    }) => {
      await openDocument(page);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

      // The document view with a document open: the whole page, which holds the ribbon, the tab
      // strip, the canvas pill and the view toolbar.
      await sweep(page.locator('body'), 'document view');

      // Each side panel: the rail buttons open one panel per side, and each panel is swept.
      for (const side of ['left', 'right'] as const) {
        const rail = page.getByRole('toolbar', {
          name: side === 'left' ? 'Left panels' : 'Right panels',
        });
        const count = await rail.getByRole('button').count();
        for (let i = 0; i < count; i++) {
          const button = rail.getByRole('button').nth(i);
          // A disabled button has no panel, and an expanded one (Thumbnails opens by default)
          // would close on a click: only a collapsed button is clicked to open its panel.
          if (await button.isDisabled()) continue;
          if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
          const panel = page.locator(`.app-panel-${side}`);
          await expect(panel, `${side} side panel ${i + 1} is open`).toBeVisible();
          await sweep(panel, `${side} side panel ${i + 1}`);
        }
      }

      // The Comment tab (issue 801): the Stamp split button's command and its arrow are each 44 px.
      await page.locator('.ribbon [role="tab"]', { hasText: /^Comment$/ }).click();
      await sweep(page.locator('.ribbon-split[data-command-split="stamp"]'), 'Stamp split button');

      // The app menu.
      await page.getByRole('button', { name: 'Main menu' }).click();
      await sweep(page.getByRole('menu').first(), 'app menu');
      await page.keyboard.press('Escape');

      // Preferences, then close it with Escape.
      const prefs = await openPreferences(page);
      await sweep(prefs, 'Preferences');
      await page.keyboard.press('Escape');

      // One engine dialog: Save As, from the app menu.
      await page.getByRole('button', { name: 'Main menu' }).click();
      await page.locator('.app-menu-item', { hasText: 'Save As…' }).click();
      const saveAs = page.getByRole('dialog', { name: 'Save As' });
      await expect(saveAs).toBeVisible();
      await sweep(saveAs, 'Save As dialog');
    });
  });
});
