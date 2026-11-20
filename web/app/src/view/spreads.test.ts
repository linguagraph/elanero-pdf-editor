import { describe, expect, it } from 'vitest';
import {
  computeColumn,
  computeSpreads,
  PAGE_GAP_PT,
  type PageBox,
  pairSpreads,
  visibleRange,
} from './layout';

const LETTER = { width: 612, height: 792 };
const K = 4 / 3;

describe('pairSpreads (two-page pairing)', () => {
  it('pairs page 1 with page 2 by default', () => {
    expect(pairSpreads(4, false)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('ends with the last page alone for an odd count', () => {
    expect(pairSpreads(5, false)).toEqual([
      [0, 1],
      [2, 3],
      [4, null],
    ]);
  });

  it('puts page 1 alone on the right when it stands alone, then pairs the rest', () => {
    expect(pairSpreads(4, true)).toEqual([
      [null, 0],
      [1, 2],
      [3, null],
    ]);
  });

  it('keeps the pairs right for an odd count with page 1 alone', () => {
    expect(pairSpreads(5, true)).toEqual([
      [null, 0],
      [1, 2],
      [3, 4],
    ]);
  });

  it('has no spreads without pages, and one page alone as a single spread', () => {
    expect(pairSpreads(0, false)).toEqual([]);
    expect(pairSpreads(0, true)).toEqual([]);
    expect(pairSpreads(1, false)).toEqual([[0, null]]);
    expect(pairSpreads(1, true)).toEqual([[null, 0]]);
  });
});

describe('computeSpreads', () => {
  const sizes = [LETTER, LETTER, LETTER];

  it('places the pages of a spread side by side, the left one at the spine', () => {
    const layout = computeSpreads(sizes, 1, false);
    const [left, right] = layout.boxes as PageBox[];
    expect(left?.index).toBe(0);
    expect(right?.index).toBe(1);
    expect(left?.top).toBe(right?.top);
    expect(right?.left).toBeCloseTo((left?.left ?? 0) + (left?.width ?? 0) + PAGE_GAP_PT * K);
  });

  it('starts the next spread below the first one', () => {
    const layout = computeSpreads(sizes, 1, false);
    const first = layout.boxes[0];
    const third = layout.boxes[2];
    expect(third?.top).toBeGreaterThan((first?.top ?? 0) + (first?.height ?? 0));
    expect(layout.height).toBeCloseTo((third?.top ?? 0) + (third?.height ?? 0) + PAGE_GAP_PT * K);
  });

  it('leaves the empty slot of a cover-alone first spread empty', () => {
    const layout = computeSpreads(sizes, 1, true);
    expect(layout.boxes.map((box) => box.index)).toEqual([0, 1, 2]);
    const cover = layout.boxes[0];
    const second = layout.boxes[1];
    // Page 1 is alone on the right, so page 2 sits on its left in the next row.
    expect(cover?.left).toBeGreaterThan(second?.left ?? 0);
    expect(cover?.top).toBeLessThan(second?.top ?? 0);
  });

  it('centres a short page vertically in its row', () => {
    const layout = computeSpreads([LETTER, { width: 612, height: 400 }], 1, false);
    const [tall, short] = layout.boxes as PageBox[];
    const expected = (tall?.top ?? 0) + ((tall?.height ?? 0) - (short?.height ?? 0)) / 2;
    expect(short?.top).toBeCloseTo(expected);
  });

  it('has no size for no pages, and scales the width with zoom', () => {
    expect(computeSpreads([], 1, false)).toEqual({
      boxes: [],
      width: 0,
      height: 0,
    });
    const layout = computeSpreads(sizes, 2, false);
    expect(layout.width).toBeCloseTo(3 * PAGE_GAP_PT * 2 * K + 2 * 612 * 2 * K);
  });

  it('is the single column when a page is taken out of the pairing', () => {
    // Sanity: a one-page spread is the same page box as the single column with the same gap.
    const single = computeColumn([LETTER], 1).boxes[0];
    const spread = computeSpreads([LETTER], 1, false).boxes[0];
    expect(spread?.width).toBeCloseTo(single?.width ?? 0);
    expect(spread?.height).toBeCloseTo(single?.height ?? 0);
  });
});

describe('visibleRange with two-page spreads', () => {
  it('keeps a tall page on screen even when the short page beside it ends above the window', () => {
    const layout = computeSpreads(
      [LETTER, { width: 612, height: 300 }, LETTER, LETTER, LETTER, LETTER],
      1,
      false,
    );
    const tall = layout.boxes[0];
    // Scroll so that the short page (index 1) is above the window and the tall one is in it.
    const scrollTop = (tall?.top ?? 0) + (tall?.height ?? 0) / 2;
    const range = visibleRange(layout.boxes, scrollTop, 10);
    expect(range.first).toBe(0);
    expect(range.end).toBeGreaterThan(0);
  });
});
