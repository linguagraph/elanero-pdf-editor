import { describe, expect, it } from 'vitest';
import { computeColumn, computeSpreads, scrollTopForAnchor, viewAnchor } from './layout';

const sizes = [
  { width: 612, height: 792 },
  { width: 842, height: 595 },
  { width: 300, height: 1200 },
  { width: 612, height: 792 },
];

describe('the reader place (W5.1a S2)', () => {
  it('names the page and the offset within it at a scroll position', () => {
    const { boxes } = computeColumn(sizes, 1);
    const box = boxes[2];
    if (box === undefined) throw new Error('no box');
    const anchor = viewAnchor(boxes, box.top + 300);
    expect(anchor?.page).toBe(2);
    expect(anchor?.yFraction).toBeCloseTo(300 / box.height, 9);
  });

  it('keeps a gap above a page as a negative offset, and past the end the last page', () => {
    const { boxes } = computeColumn(sizes, 1);
    const box = boxes[1];
    if (box === undefined) throw new Error('no box');
    expect(viewAnchor(boxes, box.top - 6)?.page).toBe(1);
    expect(viewAnchor(boxes, box.top - 6)?.yFraction).toBeLessThan(0);
    const last = boxes[3];
    if (last === undefined) throw new Error('no box');
    expect(viewAnchor(boxes, last.top + last.height + 50)).toEqual({
      page: 3,
      yFraction: (last.top + last.height + 50 - last.top) / last.height,
    });
  });

  it('is null for an empty document', () => {
    expect(viewAnchor([], 100)).toBeNull();
  });

  it('keeps the same spot across zooms, scaling the scroll position with the zoom', () => {
    const at1 = computeColumn(sizes, 1).boxes;
    const at2 = computeColumn(sizes, 2.5).boxes;
    const anchor = viewAnchor(at1, 1500);
    if (anchor === null) throw new Error('no anchor');
    expect(scrollTopForAnchor(at2, anchor)).toBeCloseTo(1500 * 2.5, 6);
  });

  it('keeps the page across a change to the two-page layout', () => {
    const column = computeColumn(sizes, 1).boxes;
    const spreads = computeSpreads(sizes, 1, false).boxes;
    const box = column[2];
    if (box === undefined) throw new Error('no box');
    const anchor = viewAnchor(column, box.top + 100);
    if (anchor === null) throw new Error('no anchor');
    const top = scrollTopForAnchor(spreads, anchor);
    const target = spreads[2];
    if (target === undefined || top === null) throw new Error('no target');
    expect(top).toBeCloseTo(target.top + (100 / box.height) * target.height, 6);
  });

  it('is null for a page index out of range', () => {
    expect(scrollTopForAnchor([], { page: 0, yFraction: 0 })).toBeNull();
  });
});
