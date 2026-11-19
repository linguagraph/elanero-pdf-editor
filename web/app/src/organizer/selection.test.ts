import { describe, expect, it } from 'vitest';
import {
  canDelete,
  clampSelection,
  duplicatedPages,
  insertAt,
  movedPages,
  moveTarget,
  NO_SELECTION,
  type PageSelection,
  selectPage,
  insertedSelection,
} from './selection';

describe('insertAt and duplicatedPages', () => {
  it('inserts after the last selected page, or at the end with no selection', () => {
    expect(insertAt([], 5)).toBe(5);
    expect(insertAt([1, 3], 5)).toBe(4);
    expect(insertAt([0], 5)).toBe(1);
  });

  it('the copies go right after the last chosen page, in order', () => {
    expect(duplicatedPages([0, 1])).toEqual([2, 3]);
    expect(duplicatedPages([0, 2])).toEqual([3, 4]);
    expect(duplicatedPages([4])).toEqual([5]);
  });
});

const PLAIN = { ctrl: false, shift: false };
const CTRL = { ctrl: true, shift: false };
const SHIFT = { ctrl: false, shift: true };

// Clicks the pages in order and returns the selection after the last click.
function clicks(steps: [number, { ctrl: boolean; shift: boolean }][]): PageSelection {
  return steps.reduce<PageSelection>(
    (selection, [index, modifiers]) => selectPage(selection, index, modifiers),
    NO_SELECTION,
  );
}

describe('selectPage', () => {
  it('a plain click selects one page and makes it the anchor', () => {
    expect(clicks([[2, PLAIN]])).toEqual({ picked: [2], anchor: 2 });
  });

  it('a plain click replaces the selection', () => {
    expect(
      clicks([
        [0, PLAIN],
        [3, PLAIN],
      ]),
    ).toEqual({ picked: [3], anchor: 3 });
  });

  it('Ctrl-click adds pages in order and keeps the existing ones', () => {
    expect(
      clicks([
        [3, PLAIN],
        [0, CTRL],
        [1, CTRL],
      ]),
    ).toEqual({ picked: [0, 1, 3], anchor: 1 });
  });

  it('Ctrl-click on a selected page takes it out', () => {
    expect(
      clicks([
        [0, PLAIN],
        [1, CTRL],
        [0, CTRL],
      ]),
    ).toEqual({ picked: [1], anchor: 0 });
  });

  it('Shift-click selects the range from the anchor, in either direction', () => {
    expect(
      clicks([
        [1, PLAIN],
        [4, SHIFT],
      ]),
    ).toEqual({ picked: [1, 2, 3, 4], anchor: 1 });
    expect(
      clicks([
        [4, PLAIN],
        [1, SHIFT],
      ]),
    ).toEqual({ picked: [1, 2, 3, 4], anchor: 4 });
  });

  it('Shift-click replaces an earlier selection with the range', () => {
    expect(
      clicks([
        [0, PLAIN],
        [2, CTRL],
        [5, PLAIN],
        [3, SHIFT],
      ]),
    ).toEqual({
      picked: [3, 4, 5],
      anchor: 5,
    });
  });

  it('Shift-click with no anchor acts as a plain click', () => {
    expect(clicks([[2, SHIFT]])).toEqual({ picked: [2], anchor: 2 });
  });
});

describe('clampSelection', () => {
  it('drops pages past the new end and an anchor that no longer exists', () => {
    expect(clampSelection({ picked: [1, 4, 6], anchor: 6 }, 5)).toEqual({
      picked: [1, 4],
      anchor: null,
    });
  });
});

describe('moveTarget', () => {
  it('moves a selection up to sit before the page above it', () => {
    expect(moveTarget('up', [3], 6)).toBe(2);
    expect(moveTarget('up', [2, 3], 6)).toBe(1);
  });

  it('cannot move up from the first page', () => {
    expect(moveTarget('up', [0, 1], 6)).toBeNull();
  });

  it('moves a selection down past the page below it', () => {
    expect(moveTarget('down', [1], 6)).toBe(3);
  });

  it('moves to the end when the page below is the last one', () => {
    expect(moveTarget('down', [4], 6)).toBe(6);
  });

  it('cannot move down from the last page, or with nothing selected', () => {
    expect(moveTarget('down', [5], 6)).toBeNull();
    expect(moveTarget('up', [], 6)).toBeNull();
  });
});

describe('canDelete', () => {
  it('allows some pages, never every page', () => {
    expect(canDelete([0], 3)).toBe(true);
    expect(canDelete([0, 1, 2], 3)).toBe(false);
    expect(canDelete([], 3)).toBe(false);
  });
});

describe('movedPages', () => {
  it('reads the new indexes of a move, and nothing else', () => {
    expect(movedPages([2, 3])).toEqual([2, 3]);
    expect(movedPages(null)).toBeNull();
    expect(movedPages(['a'])).toBeNull();
  });
});

describe('inserted selection', () => {
  it('selects the inserted pages, with the first as the anchor', () => {
    expect(insertedSelection(2, 3)).toEqual({ picked: [2, 3, 4], anchor: 2 });
  });

  it('selects nothing when no page was inserted', () => {
    expect(insertedSelection(2, 0)).toEqual({ picked: [], anchor: null });
  });
});
