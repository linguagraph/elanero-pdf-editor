// W5.4: text selection by touch under the Select tool (design W5.4-touch-select.md, sections 2 and 10).
// A long-press on a line selects the word under the finger; the finger keeps going to extend it; a
// quick swipe scrolls and selects nothing; after a selection the handles extend it, with 44 px
// targets. Playwright's touchscreen only taps, so the flows drive Input.dispatchTouchEvent through a
// CDP session, which is Chromium only, and so is the whole file. Nothing is saved, so no host check
// is recorded. text_multipage's page 1 has a heading line, then body lines (text.spec.ts reads them
// the same way).
import { type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';
import {
  captureClipboard,
  copiedTexts,
  fixture,
  openApp,
  openPdf,
  STAGED,
  watchPage,
} from './support';

type Point = { x: number; y: number };

// The text lines of one page, as the view draws them (the text layer's spans, in reading order).
function pageLines(page: Page, index: number): Locator {
  return page.locator(`[data-page="${index}"] .page-text-line`);
}

// The selection's marks on one page (SelectionMarks): one per selected line. A long-press marks the
// word under the finger at once; the live region speaks only when the gesture ends (section 6).
function selectionMarks(page: Page, index: number): Locator {
  return page.locator(`[data-page="${index}"] .page-selection-mark`);
}

// A point on a page 1 text line that the finger would really land on: the element there is the
// line itself, not an overlay (the canvas pill is centred over the page, so a line's middle can be
// covered while its ends are clear). The line is tried at a few points across its width. Returns
// null if no line has one.
async function firstUncoveredPoint(page: Page): Promise<Point | null> {
  const lines = pageLines(page, 0);
  const count = await lines.count();
  for (let i = 1; i < count; i++) {
    const box = await lines.nth(i).boundingBox();
    if (box === null) continue;
    for (const fraction of [0.5, 0.2, 0.8]) {
      const point = { x: box.x + box.width * fraction, y: box.y + box.height / 2 };
      const onText = await page.evaluate(
        ({ x, y }) =>
          (document.elementFromPoint(x, y)?.closest('.page-text-line') ?? null) !== null,
        point,
      );
      if (onText) return point;
    }
  }
  return null;
}

function centre(box: { x: number; y: number; width: number; height: number }): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// One touch event: touchStart and touchMove carry the finger's point, touchEnd lifts every finger.
async function touchEvent(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  at?: Point,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: at === undefined ? [] : [{ x: at.x, y: at.y }],
  });
}

// Moves the finger from one point to another in equal steps, one touchMove each.
async function dragFinger(cdp: CDPSession, from: Point, to: Point, steps = 10): Promise<void> {
  for (let step = 1; step <= steps; step += 1) {
    await touchEvent(cdp, 'touchMove', {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    });
  }
}

// The live region's selection announcement (W5.4 section 6): the status that names the size, set when
// a gesture ends (the finger lifts), not while it runs. A test polls it with expect.poll, so it waits
// for the state rather than for a fixed time.
async function selectionAnnouncement(page: Page): Promise<string> {
  const texts = await page.getByRole('status').allTextContents();
  return texts.find((text) => /characters? selected\./.test(text)) ?? '';
}

test.describe('engine staged', () => {
  test.skip(!STAGED, 'engine assets are not staged (scripts/stage_engine_assets.mjs); not run');
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'touch input goes through CDP, which only Chromium offers',
  );
  // A window tall enough that the document view's scroller is not a few hundred pixels high: at
  // 1280 x 720 it is 248 px, so a handle dragged to the next line sits past its edge and autoscrolls
  // the selection several lines down.
  test.use({ hasTouch: true, viewport: { width: 1920, height: 1080 } });

  test('a long-press selects the word, the finger extends it, and Copy writes both lines', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await captureClipboard(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const lines = pageLines(page, 0);
    // allTextContents does not wait, so the lines must be drawn before they are read.
    await expect(lines.nth(2)).toBeVisible();
    const all = await lines.allTextContents();
    expect(all[1]?.trim() ?? '', 'second line has text').not.toBe('');
    expect(all[2]?.trim() ?? '', 'third line has text').not.toBe('');
    const first = await lines.nth(1).boundingBox();
    const last = await lines.nth(2).boundingBox();
    if (first === null || last === null) throw new Error('page 1 has no text lines to select');

    const cdp = await page.context().newCDPSession(page);
    // The press is at the start of the line, so the word under it is the line's first word.
    const start = { x: first.x + 2, y: centre(first).y };
    await touchEvent(cdp, 'touchStart', start);
    // The hold is LONG_PRESS_MS (500 ms): the word is marked when it fires, with the finger down.
    await expect(selectionMarks(page, 0)).toHaveCount(1);
    await dragFinger(cdp, start, { x: last.x + last.width + 4, y: centre(last).y }, 12);
    await touchEvent(cdp, 'touchEnd');
    // The live region announces the size when the gesture ends, at the lift (section 6).
    await expect.poll(() => selectionAnnouncement(page)).toMatch(/characters? selected\./);

    await page.keyboard.press('Control+C');
    await expect(page.getByText('Copied to clipboard.', { exact: true })).toBeVisible();
    const written = await copiedTexts(page);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(`${all[1]}\n${all[2]}`);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('a quick swipe on text scrolls the page and selects nothing', async ({ page }) => {
    const problems = watchPage(page);
    await captureClipboard(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const scroller = page.locator('.doc-view-scroll');
    const before = await scroller.evaluate((element) => element.scrollTop);
    // The lines must be drawn before they are hit-tested (boundingBox does not wait). Then start on a
    // point of a text line that no overlay covers: the canvas pill sits over the page's bottom centre,
    // and a touch on it is a button press, not a pan of the text.
    await expect(pageLines(page, 0).nth(2)).toBeVisible();
    const start = await firstUncoveredPoint(page);
    if (start === null) throw new Error('page 1 has no text line free of overlays');

    // The finger leaves the slop long before LONG_PRESS_MS, so the gesture is a scroll (section 2).
    const cdp = await page.context().newCDPSession(page);
    await touchEvent(cdp, 'touchStart', start);
    await dragFinger(cdp, start, { x: start.x, y: start.y - 200 }, 8);
    await touchEvent(cdp, 'touchEnd');

    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before);
    await page.keyboard.press('Control+C');
    await expect(
      page.getByText('Select some text on a page first, then press Copy.', { exact: true }),
    ).toBeVisible();
    expect(await copiedTexts(page)).toHaveLength(0);

    expect(problems, 'CSP or page errors').toEqual([]);
  });

  test('the end handle extends a selection a line down, and both handles are 44 px', async ({
    page,
  }) => {
    const problems = watchPage(page);
    await captureClipboard(page);
    await openApp(page);
    await openPdf(page, 'text_multipage.pdf', fixture('text_multipage.pdf'));

    const lines = pageLines(page, 0);
    await expect(lines.nth(3)).toBeVisible();
    const all = await lines.allTextContents();
    expect(all[3]?.trim() ?? '', 'fourth line has text').not.toBe('');
    const first = await lines.nth(1).boundingBox();
    const last = await lines.nth(2).boundingBox();
    const target = await lines.nth(3).boundingBox();
    if (first === null || last === null || target === null) {
      throw new Error('page 1 has no text lines to select');
    }

    const cdp = await page.context().newCDPSession(page);
    const start = { x: first.x + 2, y: centre(first).y };
    await touchEvent(cdp, 'touchStart', start);
    await expect(selectionMarks(page, 0)).toHaveCount(1);
    await dragFinger(cdp, start, { x: last.x + last.width + 4, y: centre(last).y }, 12);
    await touchEvent(cdp, 'touchEnd');
    await expect.poll(() => selectionAnnouncement(page)).toMatch(/characters? selected\./);

    // The handles show after a touch selection (section 3). Each one is a 44 x 44 px target.
    const handles = page.locator('.selection-handle');
    await expect(handles).toHaveCount(2);
    for (const index of [0, 1]) {
      const box = await handles.nth(index).boundingBox();
      expect(box?.width, `handle ${index} width`).toBeGreaterThanOrEqual(44);
      expect(box?.height, `handle ${index} height`).toBeGreaterThanOrEqual(44);
    }

    // Drag the end handle down to the fourth line's end: the selection now covers three lines. The
    // handle hangs below its line and keeps the press's offset from the line's middle (section 3), so
    // the finger moves down by the distance between the lines, not onto the fourth line itself.
    const endHandle = await page.locator('.selection-handle--end').boundingBox();
    if (endHandle === null) throw new Error('the end handle is not drawn');
    const grip = centre(endHandle);
    await touchEvent(cdp, 'touchStart', grip);
    await dragFinger(
      cdp,
      grip,
      { x: target.x + target.width + 4, y: grip.y + centre(target).y - centre(last).y },
      12,
    );
    await touchEvent(cdp, 'touchEnd');

    await page.keyboard.press('Control+C');
    await expect(page.getByText('Copied to clipboard.', { exact: true })).toBeVisible();
    const written = await copiedTexts(page);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(`${all[1]}\n${all[2]}\n${all[3]}`);

    expect(problems, 'CSP or page errors').toEqual([]);
  });
});
