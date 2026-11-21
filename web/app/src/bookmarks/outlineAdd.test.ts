// The add arithmetic (W5.2 S3): applyAdd predicts the engine's placement, and defaultTitle names the
// new bookmark. The tree is the S2 fixture: levels [1,2,2,3,1,2,1].
import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import { applyAdd, defaultTitle } from './outlineEdit';

function outline(levels: number[]): OutlineEntry[] {
  return levels.map((level, k) => ({ title: `T${k}`, level, page: k, is_open: false, top: null }));
}

const FIXTURE = outline([1, 2, 2, 3, 1, 2, 1]);
const draft = { title: 'New', page: 4, top: 120.5 };

describe('applyAdd', () => {
  it('adds a sibling after the whole subtree of the row', () => {
    // After T0 (level 1, subtree T0..T3), the new level-1 entry is at index 4.
    const plan = applyAdd(FIXTURE, 0, false, draft);
    expect(plan.added).toBe(4);
    expect(plan.entries[4]).toEqual({
      title: 'New',
      level: 1,
      page: 4,
      is_open: false,
      top: 120.5,
    });
    expect(plan.entries.map((e) => e.level)).toEqual([1, 2, 2, 3, 1, 1, 2, 1]);
  });

  it('adds a child as the first child of the row', () => {
    // Under T4 (level 1), the first child is at index 5 and is level 2.
    const plan = applyAdd(FIXTURE, 4, true, draft);
    expect(plan.added).toBe(5);
    expect(plan.entries[5]?.level).toBe(2);
    expect(plan.entries[6]?.title).toBe('T5');
  });

  it('appends a top-level entry when there is no row to add after', () => {
    const plan = applyAdd(FIXTURE, null, false, draft);
    expect(plan.added).toBe(FIXTURE.length);
    expect(plan.entries[FIXTURE.length]?.level).toBe(1);
  });

  it('maps every old entry to its old index, and the new one to -1', () => {
    const plan = applyAdd(FIXTURE, 1, false, draft);
    // After T1 (a level-2 entry with no children), the new entry is at index 2.
    expect(plan.order).toEqual([0, 1, -1, 2, 3, 4, 5, 6]);
    expect(plan.order.filter((k) => k === -1)).toHaveLength(1);
  });

  it('gives an empty outline its first entry', () => {
    const plan = applyAdd([], null, false, draft);
    expect(plan.entries).toEqual([{ title: 'New', level: 1, page: 4, is_open: false, top: 120.5 }]);
    expect(plan.added).toBe(0);
  });
});

describe('defaultTitle', () => {
  it('uses the first non-empty line of the selection, with its spaces collapsed', () => {
    expect(defaultTitle('  \n  Introduction   to\tthe  law \nmore', null, 3)).toBe(
      'Introduction to the law',
    );
  });

  it('falls back to the page when the selection is blank', () => {
    expect(defaultTitle('   \n\t ', null, 3)).toBe('Page 3');
    expect(defaultTitle(null, null, 3)).toBe('Page 3');
  });

  it('uses the page label when the document has one, else the page number', () => {
    expect(defaultTitle(null, 'iv', 4)).toBe('Page iv');
    expect(defaultTitle(null, '  ', 4)).toBe('Page 4');
  });

  it('cuts a long selection to 120 code points, without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(119)}😀tail`;
    const title = defaultTitle(long, null, 1);
    expect(Array.from(title)).toHaveLength(120);
    expect(title.endsWith('😀')).toBe(true);
  });
});
