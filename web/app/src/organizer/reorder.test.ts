import { describe, expect, it } from 'vitest';
import {
  autoScrollStep,
  type CellBox,
  changesOrder,
  draggedPages,
  dropSlot,
  moveOrder,
  passedThreshold,
} from './reorder';

// A 3-column grid of 7 cells, 100 px wide and 50 px tall: rows 0-50, 50-100 and 100-150.
function grid3(): CellBox[] {
  return Array.from({ length: 7 }, (_, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const left = column * 100;
    const top = row * 50;
    return { left, top, right: left + 100, bottom: top + 50 };
  });
}

describe('dropSlot', () => {
  it('the left half of a cell drops before it, the right half before the next one', () => {
    const cells = grid3();
    expect(dropSlot(cells, 25, 25)).toEqual({ before: 0, marker: { index: 0, side: 'before' } });
    expect(dropSlot(cells, 75, 25)).toEqual({ before: 1, marker: { index: 1, side: 'before' } });
  });

  it('past the end of row 1 drops after its last cell', () => {
    expect(dropSlot(grid3(), 350, 25)).toEqual({ before: 3, marker: { index: 2, side: 'after' } });
  });

  it('the start of row 2 is the same slot as the end of row 1, with the marker before cell 3', () => {
    expect(dropSlot(grid3(), 5, 75)).toEqual({ before: 3, marker: { index: 3, side: 'before' } });
  });

  it('above the grid clamps to the first row, below it to the last', () => {
    expect(dropSlot(grid3(), 25, -100).before).toBe(0);
    expect(dropSlot(grid3(), 25, 999)).toEqual({ before: 6, marker: { index: 6, side: 'before' } });
  });

  it('past the last cell drops at the count, with the marker after the last cell', () => {
    expect(dropSlot(grid3(), 999, 999)).toEqual({ before: 7, marker: { index: 6, side: 'after' } });
  });

  it('tops within one pixel count as one row', () => {
    const cells: CellBox[] = [
      { left: 0, top: 100.4, right: 100, bottom: 150.4 },
      { left: 100, top: 100.6, right: 200, bottom: 150.6 },
      { left: 0, top: 160, right: 100, bottom: 210 },
    ];
    expect(dropSlot(cells, 150, 120)).toEqual({ before: 2, marker: { index: 1, side: 'after' } });
    expect(dropSlot(cells, 20, 180)).toEqual({ before: 2, marker: { index: 2, side: 'before' } });
  });

  it('a single column drops between the cells it stacks', () => {
    const cells: CellBox[] = [0, 1, 2].map((index) => ({
      left: 0,
      top: index * 50,
      right: 100,
      bottom: index * 50 + 50,
    }));
    expect(dropSlot(cells, 10, 75)).toEqual({ before: 1, marker: { index: 1, side: 'before' } });
    expect(dropSlot(cells, 90, 75)).toEqual({ before: 2, marker: { index: 1, side: 'after' } });
  });

  it('an empty grid drops at 0 with no marker', () => {
    expect(dropSlot([], 10, 10)).toEqual({ before: 0, marker: null });
  });
});

describe('moveOrder and changesOrder (parity with services/pages.py move_order)', () => {
  it('moves a page to the end', () => {
    expect(moveOrder(5, [0], 5)).toEqual({ order: [1, 2, 3, 4, 0], placed: [4] });
  });

  it('moves scattered pages to the end as one block', () => {
    expect(moveOrder(5, [0, 2], 5)).toEqual({ order: [1, 3, 4, 0, 2], placed: [3, 4] });
    expect(changesOrder(5, [0, 2], 5)).toBe(true);
  });

  it('moves scattered pages to the front', () => {
    expect(moveOrder(5, [3, 4], 0)).toEqual({ order: [3, 4, 0, 1, 2], placed: [0, 1] });
  });

  it('a target inside the moved block moves the block (pages 1 and 3 before 2)', () => {
    expect(moveOrder(5, [1, 3], 2)).toEqual({ order: [0, 1, 3, 2, 4], placed: [1, 2] });
    expect(changesOrder(5, [1, 3], 2)).toBe(true);
  });

  it('drops that leave the order as it is do not change it', () => {
    expect(changesOrder(5, [1], 1)).toBe(false);
    expect(changesOrder(5, [1], 2)).toBe(false);
    expect(changesOrder(5, [2, 3], 3)).toBe(false);
  });

  it('repeated and unsorted pages are treated as one set', () => {
    expect(moveOrder(5, [2, 0, 2], 5).order).toEqual([1, 3, 4, 0, 2]);
  });
});

describe('draggedPages', () => {
  it('carries the whole selection when the pressed page is in it', () => {
    expect(draggedPages([0, 2, 3], 2)).toEqual([0, 2, 3]);
  });

  it('carries only the pressed page when it is not in the selection', () => {
    expect(draggedPages([0, 2, 3], 1)).toEqual([1]);
    expect(draggedPages([], 4)).toEqual([4]);
  });

  it('returns a sorted copy', () => {
    expect(draggedPages([3, 0], 0)).toEqual([0, 3]);
  });
});

describe('passedThreshold', () => {
  it('needs the pointer to move at least 5 px in a straight line', () => {
    expect(passedThreshold(3, 4)).toBe(true);
    expect(passedThreshold(2, 2)).toBe(false);
    expect(passedThreshold(0, 0)).toBe(false);
  });
});

describe('autoScrollStep', () => {
  it('is zero away from both edges', () => {
    expect(autoScrollStep(250, 0, 500)).toBe(0);
    expect(autoScrollStep(40, 0, 500)).toBe(0);
    expect(autoScrollStep(460, 0, 500)).toBe(0);
  });

  it('is negative near the top edge and positive near the bottom edge', () => {
    expect(autoScrollStep(20, 0, 500)).toBeLessThan(0);
    expect(autoScrollStep(480, 0, 500)).toBeGreaterThan(0);
  });

  it('grows linearly inside the band and is capped at the maximum', () => {
    expect(autoScrollStep(20, 0, 500)).toBeCloseTo(-8);
    expect(autoScrollStep(480, 0, 500)).toBeCloseTo(8);
    expect(autoScrollStep(0, 0, 500)).toBeCloseTo(-16);
    expect(autoScrollStep(-100, 0, 500)).toBeCloseTo(-16);
    expect(autoScrollStep(600, 0, 500)).toBeCloseTo(16);
  });
});
