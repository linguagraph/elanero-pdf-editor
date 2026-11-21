// The arithmetic of the bookmark edits (W5.2 S2), on the flat outline the engine returns. Each
// function works on the entries as the panel shows them; `applyMove` predicts the engine's result so
// the panel can keep the expansion and the focus without waiting for the reload. The rule is the
// engine's (`outline.move` in actions/outline.py): `parent` is read before the move and `position`
// is counted in the parent's child list after the entry has left it. A reference test pins this.
import type { OutlineEntry } from '../rpc/generated';

export type MoveDirection = 'up' | 'down' | 'in' | 'out';

export interface MoveTarget {
  // The parent's flat index before the move, or null for the top level.
  readonly parent: number | null;
  readonly position: number;
}

export interface MovePlan {
  readonly entries: OutlineEntry[];
  // order[newIndex] is the entry's old index.
  readonly order: number[];
  // The moved entry's flat index after the move.
  readonly moved: number;
}

// The first index after `i` whose level is not deeper than entry `i`'s, or the length of the list.
export function subtreeEnd(e: readonly OutlineEntry[], i: number): number {
  const level = e[i]?.level ?? 0;
  let j = i + 1;
  while (j < e.length && (e[j]?.level ?? 0) > level) j += 1;
  return j;
}

// The nearest entry above `i` with a smaller level: its parent, or null at the top level.
export function parentOf(e: readonly OutlineEntry[], i: number): number | null {
  const level = e[i]?.level ?? 0;
  for (let j = i - 1; j >= 0; j -= 1) {
    if ((e[j]?.level ?? 0) < level) return j;
  }
  return null;
}

// The flat indices of the children of `parent` (null for the top level), in order.
export function childrenOf(e: readonly OutlineEntry[], parent: number | null): number[] {
  if (parent === null) {
    const top: number[] = [];
    e.forEach((entry, j) => {
      if (entry.level === 1) top.push(j);
    });
    return top;
  }
  const childLevel = (e[parent]?.level ?? 0) + 1;
  const children: number[] = [];
  for (let j = parent + 1; j < subtreeEnd(e, parent); j += 1) {
    if (e[j]?.level === childLevel) children.push(j);
  }
  return children;
}

// Where `i` sits among its siblings.
export function slotOf(e: readonly OutlineEntry[], i: number): number {
  return childrenOf(e, parentOf(e, i)).indexOf(i);
}

// The engine's parent and position for one move of entry `i`, or null when the move is impossible
// (the table in docs/web/design/W5.2-S2.md, section 3).
export function moveTarget(
  e: readonly OutlineEntry[],
  i: number,
  direction: MoveDirection,
): MoveTarget | null {
  const parent = parentOf(e, i);
  const siblings = childrenOf(e, parent);
  const slot = siblings.indexOf(i);
  if (slot < 0) return null;
  switch (direction) {
    case 'up':
      return slot > 0 ? { parent, position: slot - 1 } : null;
    case 'down':
      return slot < siblings.length - 1 ? { parent, position: slot + 1 } : null;
    case 'in': {
      const previous = siblings[slot - 1];
      if (previous === undefined) return null;
      // The entry is not a child of `previous`, so the count is the same before and after the move.
      return { parent: previous, position: childrenOf(e, previous).length };
    }
    case 'out': {
      if (parent === null) return null;
      const grand = parentOf(e, parent);
      const uncles = childrenOf(e, grand);
      return { parent: grand, position: uncles.indexOf(parent) + 1 };
    }
  }
}

// The new outline after moving entry `i` under `parent` at `position`: the span of `i` and its
// subtree is cut, the parent is found in what is left, and the span is put in at the position with
// its levels shifted to the new depth.
export function applyMove(
  e: readonly OutlineEntry[],
  i: number,
  parent: number | null,
  position: number,
): MovePlan {
  const end = subtreeEnd(e, i);
  const n = end - i;
  const inSpan = (k: number) => k >= i && k < end;
  const rest = e.map((_, k) => k).filter((k) => !inSpan(k));
  // The parent sits before `i` (unchanged) or after the span (shifted down by its size).
  const parentRest = parent === null ? null : parent < i ? parent : parent - n;
  const restEntries = rest.map((k) => e[k]).filter((x): x is OutlineEntry => x !== undefined);
  const kids = childrenOf(restEntries, parentRest);
  const at =
    position < kids.length
      ? (kids[position] ?? 0)
      : parentRest === null
        ? rest.length
        : subtreeEnd(restEntries, parentRest);
  const parentLevel = parentRest === null ? 0 : (restEntries[parentRest]?.level ?? 0);
  const delta = parentLevel + 1 - (e[i]?.level ?? 0);
  const span = Array.from({ length: n }, (_, offset) => i + offset);
  const order = [...rest.slice(0, at), ...span, ...rest.slice(at)];
  const entries = order.map((k) => {
    const entry = e[k];
    if (entry === undefined) throw new Error('outlineEdit: index out of range');
    return inSpan(k) ? { ...entry, level: entry.level + delta } : entry;
  });
  return { entries, order, moved: at };
}

// The outline without entry `i` and its subtree, with the old index of each remaining entry.
export function applyDelete(
  e: readonly OutlineEntry[],
  i: number,
): { entries: OutlineEntry[]; order: number[] } {
  const end = subtreeEnd(e, i);
  const order = e.map((_, k) => k).filter((k) => k < i || k >= end);
  return {
    entries: order.map((k) => e[k]).filter((x): x is OutlineEntry => x !== undefined),
    order,
  };
}

// The row to focus after deleting entry `i`: its next sibling (whose new index is `i`), else the
// previous sibling, else the parent; null when no rows are left.
export function deleteFocus(e: readonly OutlineEntry[], i: number): number | null {
  const parent = parentOf(e, i);
  const siblings = childrenOf(e, parent);
  const slot = siblings.indexOf(i);
  const next = siblings[slot + 1];
  if (next !== undefined) return next - (subtreeEnd(e, i) - i);
  const previous = siblings[slot - 1];
  if (previous !== undefined) return previous;
  return parent;
}

// Moves the expanded set to the new indices. `order[newIndex]` is the entry's old index; an entry
// that left the outline drops out of the set.
export function remapExpanded(
  expanded: ReadonlySet<number>,
  order: readonly number[],
): Set<number> {
  const next = new Set<number>();
  order.forEach((oldIndex, newIndex) => {
    if (expanded.has(oldIndex)) next.add(newIndex);
  });
  return next;
}
