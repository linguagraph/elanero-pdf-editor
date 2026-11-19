import { describe, expect, it } from 'vitest';
import { computeColumn, PAGE_GAP_PT } from './layout';
import { CSS_PX_PER_POINT } from './zoom';

// The page gap is 12 pt at every zoom, as on the desktop (core/layout.py PAGE_GAP), so the space
// above the first page, between pages and below the last one is the same. Checked on the numbers,
// not on the pixels.
const LETTER = { width: 612, height: 792 };

describe('page gaps on the canvas', () => {
  it('leaves a 12 pt gap above the first page, which is 16 px at 100%', () => {
    const column = computeColumn([LETTER, LETTER], 1);
    expect(PAGE_GAP_PT * CSS_PX_PER_POINT).toBeCloseTo(16);
    expect(column.boxes[0]?.top).toBeCloseTo(16);
  });

  it('puts the same gap between pages and below the last one', () => {
    const column = computeColumn([LETTER, LETTER, LETTER], 1.5);
    const [a, b, c] = column.boxes;
    if (a === undefined || b === undefined || c === undefined) throw new Error('three pages');
    const gap = PAGE_GAP_PT * 1.5 * CSS_PX_PER_POINT;
    expect(b.top - (a.top + a.height)).toBeCloseTo(gap);
    expect(c.top - (b.top + b.height)).toBeCloseTo(gap);
    expect(column.height).toBeCloseTo(c.top + c.height + gap);
  });

  it('scales the gap with the zoom', () => {
    const at1 = computeColumn([LETTER], 1).boxes[0]?.top ?? 0;
    const at2 = computeColumn([LETTER], 2).boxes[0]?.top ?? 0;
    expect(at2).toBeCloseTo(at1 * 2);
  });
});
