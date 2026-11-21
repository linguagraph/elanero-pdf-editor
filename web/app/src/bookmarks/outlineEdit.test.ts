import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import {
  applyDelete,
  applyMove,
  childrenOf,
  deleteFocus,
  moveTarget,
  parentOf,
  remapExpanded,
  slotOf,
  subtreeEnd,
  type MoveDirection,
} from './outlineEdit';

function outline(levels: number[]): OutlineEntry[] {
  return levels.map((level, k) => ({ title: `T${k}`, level, page: k, is_open: false }));
}

// Levels [1,2,2,3,1,2,1]: T0 has children T1 and T2 (T2 has T3); T4 has T5; T6 is alone.
const FIXTURE = outline([1, 2, 2, 3, 1, 2, 1]);
// A four-level chain, then a sibling of the first entry.
const CHAIN = outline([1, 2, 3, 4, 2, 1]);

interface Node {
  readonly idx: number;
  readonly entry: OutlineEntry;
  readonly kids: Node[];
}

// The engine's rule, written on a nested tree: take the entry out of its list, then insert it into
// the parent's child list (read before the removal) at the position, which counts after the removal.
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

describe('outline structure', () => {
  it('finds subtree ends, parents, children and slots', () => {
    expect(subtreeEnd(FIXTURE, 0)).toBe(4);
    expect(subtreeEnd(FIXTURE, 2)).toBe(4);
    expect(subtreeEnd(FIXTURE, 6)).toBe(7);
    expect(parentOf(FIXTURE, 3)).toBe(2);
    expect(parentOf(FIXTURE, 5)).toBe(4);
    expect(parentOf(FIXTURE, 4)).toBeNull();
    expect(childrenOf(FIXTURE, null)).toEqual([0, 4, 6]);
    expect(childrenOf(FIXTURE, 0)).toEqual([1, 2]);
    expect(childrenOf(FIXTURE, 2)).toEqual([3]);
    expect(slotOf(FIXTURE, 2)).toBe(1);
    expect(slotOf(FIXTURE, 6)).toBe(2);
  });
});

describe('moveTarget', () => {
  it('gives each direction its engine parent and position, and none at the edges', () => {
    expect(moveTarget(FIXTURE, 1, 'up')).toBeNull();
    expect(moveTarget(FIXTURE, 2, 'down')).toBeNull();
    expect(moveTarget(FIXTURE, 1, 'in')).toBeNull();
    expect(moveTarget(FIXTURE, 6, 'out')).toBeNull();
    expect(moveTarget(FIXTURE, 2, 'up')).toEqual({ parent: 0, position: 0 });
    expect(moveTarget(FIXTURE, 1, 'down')).toEqual({ parent: 0, position: 1 });
    // Indent into the entry above, which already has a child: the entry becomes its second child.
    expect(moveTarget(FIXTURE, 2, 'in')).toEqual({ parent: 1, position: 0 });
    expect(moveTarget(FIXTURE, 5, 'in')).toBeNull();
    // Outdent lands after the parent's whole subtree.
    expect(moveTarget(FIXTURE, 2, 'out')).toEqual({ parent: null, position: 1 });
  });
});

describe('applyMove', () => {
  const directions: MoveDirection[] = ['up', 'down', 'in', 'out'];
  for (const [name, e] of [
    ['the fixture', FIXTURE],
    ['a four-level chain', CHAIN],
  ] as const) {
    it(`matches the engine's rule for every entry and direction in ${name}`, () => {
      e.forEach((_, i) => {
        for (const direction of directions) {
          const target = moveTarget(e, i, direction);
          if (target === null) continue;
          const plan = applyMove(e, i, target.parent, target.position);
          const expected = reference(e, i, target.parent, target.position);
          expect(plan.order).toEqual(expected.map((row) => row.idx));
          expect(plan.entries.map((entry) => entry.level)).toEqual(
            expected.map((row) => row.level),
          );
          expect(plan.entries.map((entry) => entry.title)).toEqual(plan.order.map((k) => `T${k}`));
          expect(plan.moved).toBe(expected.findIndex((row) => row.idx === i));
        }
      });
    });
  }
});

describe('delete', () => {
  it('cuts the subtree and remaps the expansion', () => {
    const removed = applyDelete(FIXTURE, 0);
    expect(removed.entries.map((entry) => entry.title)).toEqual(['T4', 'T5', 'T6']);
    expect(removed.order).toEqual([4, 5, 6]);
    expect(remapExpanded(new Set([0, 4, 5]), removed.order)).toEqual(new Set([0, 1]));
  });

  it('focuses the next sibling, else the previous sibling, else the parent', () => {
    expect(deleteFocus(FIXTURE, 1)).toBe(1); // next sibling T2 moves into index 1
    expect(deleteFocus(FIXTURE, 2)).toBe(1); // no next: previous sibling T1
    expect(deleteFocus(FIXTURE, 3)).toBe(2); // only child: the parent T2
    expect(deleteFocus(FIXTURE, 0)).toBe(0); // T4 moves into index 0
    expect(deleteFocus(FIXTURE, 6)).toBe(4); // last top-level entry: previous sibling T4
    expect(deleteFocus(outline([1]), 0)).toBeNull();
  });
});
