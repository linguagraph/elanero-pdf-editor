import { describe, expect, it } from 'vitest';
import {
  computeColumn,
  currentPageIndex,
  distanceToCentre,
  isInViewport,
  PAGE_GAP_PT,
  type PageBox,
  visibleRange,
} from './layout';

const LETTER = { width: 612, height: 792 };
const K = 4 / 3;

describe('computeColumn', () => {
  it('stacks pages with the gap between and around them, in CSS pixels', () => {
    const column = computeColumn([LETTER, LETTER], 1);
    const gap = PAGE_GAP_PT * K;
    expect(column.boxes[0]?.top).toBeCloseTo(gap, 9);
    expect(column.boxes[0]?.height).toBeCloseTo(792 * K, 9);
    expect(column.boxes[1]?.top).toBeCloseTo(gap + 792 * K + gap, 9);
    expect(column.height).toBeCloseTo(gap + 2 * 792 * K + 2 * gap, 9);
    expect(column.width).toBeCloseTo(612 * K + 2 * gap, 9);
  });

  it('scales with zoom', () => {
    const box = computeColumn([LETTER], 2).boxes[0];
    expect(box?.width).toBeCloseTo(612 * 2 * K, 9);
  });

  it('centres a narrower page on the widest one', () => {
    const column = computeColumn([LETTER, { width: 300, height: 400 }], 1);
    const wide = column.boxes[0];
    const narrow = column.boxes[1];
    const expected = (wide?.left ?? 0) + (612 * K) / 2 - (300 * K) / 2;
    expect(narrow?.left).toBeCloseTo(expected, 9);
  });

  it('has no height for an empty document', () => {
    expect(computeColumn([], 1).height).toBe(0);
  });
});

describe('visibleRange', () => {
  // 1000 pages of 100 px with no gaps: page i spans [100i, 100i + 100).
  const boxes: PageBox[] = Array.from({ length: 1000 }, (_, index) => ({
    index,
    top: index * 100,
    left: 0,
    width: 100,
    height: 100,
  }));

  it('keeps one viewport above and below the window', () => {
    // Viewport 300 px at scroll 5000: the window is [4700, 5600], so pages 46 to 56 are kept.
    expect(visibleRange(boxes, 5000, 300)).toEqual({ first: 46, end: 57 });
  });

  it('starts at the first page at the top', () => {
    expect(visibleRange(boxes, 0, 300)).toEqual({ first: 0, end: 7 });
  });

  it('ends at the last page at the bottom', () => {
    const range = visibleRange(boxes, 99_700, 300);
    expect(range.end).toBe(1000);
    expect(range.first).toBeLessThan(1000);
  });

  it('is empty without pages', () => {
    expect(visibleRange([], 0, 300)).toEqual({ first: 0, end: 0 });
  });

  it('stays at about three viewports of pages for any scroll position', () => {
    const range = visibleRange(boxes, 40_000, 400);
    expect(range.end - range.first).toBeLessThanOrEqual(16);
  });
});

describe('viewport helpers', () => {
  const box: PageBox = { index: 0, top: 100, left: 0, width: 50, height: 200 };

  it('tells whether a page intersects the viewport', () => {
    expect(isInViewport(box, 0, 100)).toBe(false);
    expect(isInViewport(box, 0, 101)).toBe(true);
    expect(isInViewport(box, 299, 10)).toBe(true);
    expect(isInViewport(box, 300, 10)).toBe(false);
  });

  it('measures the distance from the page centre to the viewport centre', () => {
    // The page centre is at 200 and the viewport centre at 200 for a 400 px viewport from 0.
    expect(distanceToCentre(box, 0, 400)).toBe(0);
    expect(distanceToCentre(box, 0, 200)).toBe(100);
  });
});

describe('currentPageIndex', () => {
  // Three 100 px pages with no gaps: page i spans [100i, 100i + 100).
  const boxes: PageBox[] = [0, 1, 2].map((index) => ({
    index,
    top: index * 100,
    left: 0,
    width: 100,
    height: 100,
  }));

  it('is the first page at the top of the document', () => {
    expect(currentPageIndex(boxes, 0, 100)).toBe(0);
  });

  it('is the page whose centre is nearest the middle of the viewport', () => {
    // The viewport from 120 to 220 has its centre at 170, on page 1.
    expect(currentPageIndex(boxes, 120, 100)).toBe(1);
    // From 160 to 260 the centre is at 210, on page 2.
    expect(currentPageIndex(boxes, 160, 100)).toBe(2);
  });

  it('is the last page when scrolled to the end', () => {
    expect(currentPageIndex(boxes, 200, 100)).toBe(2);
  });

  it('stays inside the document when the scroll is past its end', () => {
    expect(currentPageIndex(boxes, 5000, 100)).toBe(2);
  });

  it('is 0 for an empty document', () => {
    expect(currentPageIndex([], 0, 100)).toBe(0);
  });
});
