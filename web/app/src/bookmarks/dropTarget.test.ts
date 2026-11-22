import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import {
  applyMove,
  dropTarget,
  gapLevels,
  parentOf,
  slotOf,
  subtreeEnd,
  type DropAnchor,
} from './outlineEdit';
import { hitAt, levelAt, resolveDrop } from './drop';
import { visibleRows } from './tree';

function outline(levels: number[]): OutlineEntry[] {
  return levels.map((level, k) => ({ title: `T${k}`, level, page: k, is_open: false, top: null }));
}

// Levels [1,2,2,3,1,2,1]: T0 has children T1 and T2 (T2 has T3); T4 has T5; T6 is alone.
const FIXTURE = outline([1, 2, 2, 3, 1, 2, 1]);
// A four-level chain, then a sibling of the first entry.
const CHAIN = outline([1, 2, 3, 4, 2, 1]);
const SMALL = outline([1, 2, 3, 1, 2]);

interface Node {
  readonly idx: number;
  readonly entry: OutlineEntry;
  readonly kids: Node[];
}

// The engine's rule on a nested tree (as outlineEdit.test.ts): remove the entry, then insert it into
// the parent's child list at the position, which counts after the removal.
function reference(
  e: readonly OutlineEntry[],
  i: number,
  parent: number | null,
  position: number,
): { idx: number; level: number }[] {
  const nodes: Node[] = e.map((entry, idx) => ({ idx, entry, kids: [] }));
  const top: Node[] = [];
  const stack: Node[] = [];
  for (const node of nodes) {
    while ((stack.at(-1)?.entry.level ?? 0) >= node.entry.level) stack.pop();
    const owner = stack.at(-1);
    (owner === undefined ? top : owner.kids).push(node);
    stack.push(node);
  }
  const moving = nodes[i];
  if (moving === undefined) throw new Error('no entry');
  const listOf = (list: Node[]): Node[] | undefined => {
    if (list.includes(moving)) return list;
    for (const node of list) {
      const found = listOf(node.kids);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const oldList = listOf(top);
  const target = parent === null ? top : (nodes[parent]?.kids ?? []);
  if (oldList === undefined) throw new Error('no list');
  oldList.splice(oldList.indexOf(moving), 1);
  target.splice(position, 0, moving);
  const out: { idx: number; level: number }[] = [];
  const walk = (list: Node[], depth: number): void => {
    for (const node of list) {
      out.push({ idx: node.idx, level: depth + 1 });
      walk(node.kids, depth + 1);
    }
  };
  walk(top, 0);
  return out;
}

describe('dropTarget: the worked examples of the design', () => {
  it.each([
    ['T5 on the line T3/T4 at level 1', 5, { kind: 'gap', above: 3, below: 4, level: 1 }, null, 1],
    ['T5 on the line T3/T4 at level 2', 5, { kind: 'gap', above: 3, below: 4, level: 2 }, 0, 2],
    ['T5 on the line T3/T4 at level 3', 5, { kind: 'gap', above: 3, below: 4, level: 3 }, 2, 1],
    [
      'T1 on the line T2/T3 (T2 open) at level 3',
      1,
      { kind: 'gap', above: 2, below: 3, level: 3 },
      2,
      0,
    ],
    ['T0 on the line T5/T6 at level 1', 0, { kind: 'gap', above: 5, below: 6, level: 1 }, null, 1],
  ] as const)('%s', (_name, i, anchor, parent, position) => {
    expect(dropTarget(FIXTURE, i, anchor as DropAnchor)).toEqual({
      kind: 'move',
      target: { parent, position },
    });
  });

  it('refuses an inside drop into the entry itself or its subtree', () => {
    expect(dropTarget(FIXTURE, 0, { kind: 'inside', row: 3 })).toEqual({ kind: 'own' });
    expect(dropTarget(FIXTURE, 2, { kind: 'gap', above: 2, below: 3, level: 3 })).toEqual({
      kind: 'own',
    });
  });

  it('answers same for the line just above or below the entry itself', () => {
    // T1 sits at slot 0 under T0; the line between T1 and T2 is its own place.
    expect(dropTarget(FIXTURE, 1, { kind: 'gap', above: 1, below: 2, level: 2 })).toEqual({
      kind: 'same',
    });
  });
});

describe('dropTarget agrees with the engine', () => {
  for (const e of [FIXTURE, CHAIN, SMALL]) {
    it(`matches the reference for every drop on a ${e.length}-entry outline`, () => {
      const n = e.length;
      for (let i = 0; i < n; i += 1) {
        const anchors: DropAnchor[] = [];
        for (let r = 0; r < n; r += 1) anchors.push({ kind: 'inside', row: r });
        for (let k = 0; k <= n; k += 1) {
          const above = k > 0 ? k - 1 : null;
          const below = k < n ? k : null;
          const aboveOpen = above !== null && (e[above + 1]?.level ?? 0) > (e[above]?.level ?? 0);
          const range = gapLevels(e, above, below, aboveOpen);
          for (let level = range.min; level <= range.max; level += 1) {
            anchors.push({ kind: 'gap', above, below, level });
          }
        }
        for (const anchor of anchors) {
          const result = dropTarget(e, i, anchor);
          const end = subtreeEnd(e, i);
          if (anchor.kind === 'inside' && anchor.row >= i && anchor.row < end) {
            expect(result).toEqual({ kind: 'own' });
          }
          if (result.kind === 'same') {
            const plan = applyMove(e, i, parentOf(e, i), slotOf(e, i));
            expect(plan.order).toEqual(e.map((_, k) => k));
          }
          if (result.kind !== 'move') continue;
          const { parent, position } = result.target;
          const plan = applyMove(e, i, parent, position);
          const ref = reference(e, i, parent, position);
          expect(plan.order).toEqual(ref.map((entry) => entry.idx));
          expect(plan.entries.map((entry) => entry.level)).toEqual(ref.map((entry) => entry.level));
          if (anchor.kind === 'gap') {
            // The entry lands at the line's level.
            expect(plan.entries[plan.moved]?.level).toBe(anchor.level);
          } else {
            expect(plan.entries[plan.moved]?.level).toBe((e[anchor.row]?.level ?? 0) + 1);
          }
        }
      }
    });
  }
});

describe('dropTarget depth limit', () => {
  // A 32-level chain, then a top-level entry with one child.
  const DEEP = outline([...Array.from({ length: 32 }, (_, k) => k + 1), 1, 2]);

  it('refuses a move that would go past 32 levels and deeper than the outline', () => {
    // The sibling's subtree is one level deep, so inside the level-32 entry it would reach 34.
    expect(dropTarget(DEEP, 32, { kind: 'inside', row: 31 })).toEqual({ kind: 'deep' });
    // A leaf inside the level-32 entry would be level 33.
    expect(dropTarget(DEEP, 33, { kind: 'inside', row: 31 })).toEqual({ kind: 'deep' });
  });

  it('allows a move that stays within 32 levels', () => {
    expect(dropTarget(DEEP, 33, { kind: 'inside', row: 30 })).toEqual({
      kind: 'move',
      target: { parent: 30, position: 1 },
    });
  });
});

describe('gapLevels', () => {
  it('allows one level deeper than an open entry, and no deeper than a closed one', () => {
    expect(gapLevels(FIXTURE, 2, 3, true)).toEqual({ min: 3, max: 3 });
    expect(gapLevels(FIXTURE, 2, 4, false)).toEqual({ min: 1, max: 2 });
  });

  it('starts at the top level above the first row, and ends at the top level below the last', () => {
    expect(gapLevels(FIXTURE, null, 0, false)).toEqual({ min: 1, max: 1 });
    expect(gapLevels(FIXTURE, 6, null, false)).toEqual({ min: 1, max: 1 });
  });
});

describe('hitAt and levelAt', () => {
  // Three 44 px rows, stacked from the list's top.
  const boxes = [
    { top: 0, bottom: 44 },
    { top: 44, bottom: 88 },
    { top: 88, bottom: 132 },
  ];

  it('reads the top and bottom quarter of a row as the gaps, the middle as the row', () => {
    expect(hitAt(boxes, 5)).toEqual({ kind: 'gap', slot: 0 });
    expect(hitAt(boxes, 22)).toEqual({ kind: 'inside', row: 0 });
    expect(hitAt(boxes, 40)).toEqual({ kind: 'gap', slot: 1 });
    expect(hitAt(boxes, 60)).toEqual({ kind: 'inside', row: 1 });
  });

  it('reads the space above the first row and below the last as the end gaps', () => {
    expect(hitAt(boxes, -10)).toEqual({ kind: 'gap', slot: 0 });
    expect(hitAt(boxes, 300)).toEqual({ kind: 'gap', slot: 3 });
  });

  it('clamps the level from the horizontal position', () => {
    expect(levelAt(0, 8, 20, 1, 3)).toBe(1);
    expect(levelAt(30, 8, 20, 1, 3)).toBe(2);
    expect(levelAt(500, 8, 20, 1, 3)).toBe(3);
  });
});

describe('resolveDrop', () => {
  it('puts the line on the row below, at the level the pointer picks', () => {
    const rows = visibleRows(FIXTURE, new Set([0, 2]));
    // The line between T2 (open, its child T3 is visible) and T3: level 3 is its first child.
    const resolved = resolveDrop(
      FIXTURE,
      rows,
      1,
      { kind: 'gap', slot: rows.findIndex((row) => row.index === 3) },
      60,
      { origin: 8, step: 20 },
    );
    expect(resolved?.result).toEqual({ kind: 'move', target: { parent: 2, position: 0 } });
    expect(resolved?.mark?.edge).toBe('before');
    expect(resolved?.label.message).toBe('first');
  });

  it('shows an inside highlight on the row and refuses a drop into its own subtree', () => {
    // T0 and T2 open: the visible row 3 is T3, inside T0's subtree.
    const rows = visibleRows(FIXTURE, new Set([0, 2]));
    const resolved = resolveDrop(FIXTURE, rows, 0, { kind: 'inside', row: 3 }, 0, {
      origin: 8,
      step: 20,
    });
    expect(resolved?.result).toEqual({ kind: 'own' });
    expect(resolved?.mark).toEqual({ row: 3, edge: 'inside', depth: 3 });
  });
});
