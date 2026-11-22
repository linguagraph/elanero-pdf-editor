// The hit test of a bookmark drag (W5.2 drag and drop), pure so the bands are tested without a DOM.
// The rows are the visible rows in order, each with its box in list-content coordinates. A row's
// top quarter is the line above it, its bottom quarter the line below it, and the middle is the row
// itself. The level of a line follows the pointer's horizontal position, clamped to what the line
// allows (outlineEdit.gapLevels).
import { dropLabel, dropTarget, gapLevels, type DropAnchor, type DropResult } from './outlineEdit';
import type { OutlineEntry } from '../rpc/generated';
import type { BookmarkRow } from './tree';

export interface RowBox {
  readonly top: number;
  readonly bottom: number;
}

// `slot` is a line between visible rows: 0 above the first, rows.length below the last.
export type Hit =
  | { readonly kind: 'inside'; readonly row: number }
  | { readonly kind: 'gap'; readonly slot: number };

export function hitAt(boxes: readonly RowBox[], y: number): Hit {
  const first = boxes[0];
  if (first === undefined || y < first.top) return { kind: 'gap', slot: 0 };
  for (let row = 0; row < boxes.length; row += 1) {
    const box = boxes[row];
    if (box === undefined) continue;
    const band = (box.bottom - box.top) / 4;
    if (y < box.top + band) return { kind: 'gap', slot: row };
    if (y <= box.bottom - band) return { kind: 'inside', row };
    if (y <= box.bottom) return { kind: 'gap', slot: row + 1 };
  }
  return { kind: 'gap', slot: boxes.length };
}

// The level a horizontal position picks: `origin` is the depth-1 padding, `step` the indent per level.
export function levelAt(x: number, origin: number, step: number, min: number, max: number): number {
  const level = Math.floor((x - origin) / step) + 1;
  return Math.min(max, Math.max(min, level));
}

// Where a drag is pointing and what a release would do there.
export interface Resolved {
  readonly anchor: DropAnchor;
  readonly result: DropResult;
  // The row the line (or the inside highlight) is drawn on, its edge, and the depth it starts at.
  readonly mark: {
    readonly row: number;
    readonly edge: 'before' | 'after' | 'inside';
    readonly depth: number;
  } | null;
  readonly label: ReturnType<typeof dropLabel>;
  readonly level: number;
}

// Resolves a hit for the entry at flat index `index`. `x` is the pointer's distance from the list's
// inline-start edge, `origin` and `step` the indent geometry. Null when the list has no rows.
export function resolveDrop(
  entries: readonly OutlineEntry[],
  rows: readonly BookmarkRow[],
  index: number,
  hit: Hit,
  x: number,
  geometry: { readonly origin: number; readonly step: number },
): Resolved | null {
  if (hit.kind === 'inside') {
    const row = rows[hit.row];
    if (row === undefined) return null;
    const anchor: DropAnchor = { kind: 'inside', row: row.index };
    return {
      anchor,
      result: dropTarget(entries, index, anchor),
      mark: { row: hit.row, edge: 'inside', depth: row.entry.level },
      label: dropLabel(entries, anchor),
      level: row.entry.level,
    };
  }
  const above = hit.slot > 0 ? rows[hit.slot - 1] : undefined;
  const below = rows[hit.slot];
  if (above === undefined && below === undefined) return null;
  const range = gapLevels(
    entries,
    above?.index ?? null,
    below?.index ?? null,
    above?.expanded === true,
  );
  const level = levelAt(x, geometry.origin, geometry.step, range.min, range.max);
  const anchor: DropAnchor = {
    kind: 'gap',
    above: above?.index ?? null,
    below: below?.index ?? null,
    level,
  };
  // The line sits on the row below it, or on the last row when it is at the end of the list.
  const mark =
    below !== undefined
      ? { row: hit.slot, edge: 'before' as const, depth: level }
      : { row: hit.slot - 1, edge: 'after' as const, depth: level };
  return {
    anchor,
    result: dropTarget(entries, index, anchor),
    mark,
    label: dropLabel(entries, anchor),
    level,
  };
}
