// The bookmarks tree, worked out from the flat outline the engine returns (W5.2). Each entry carries
// its level; an entry's children are the entries after it with a greater level, up to the next entry
// at its own level or above. Pure functions, so the panel and the tests share them.
import type { OutlineEntry } from '../rpc/generated';
import type { MoveDirection } from './outlineEdit';

export interface BookmarkRow {
  // The entry's index in the flat outline; it is also the key of its expansion state.
  readonly index: number;
  readonly entry: OutlineEntry;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

// Whether the entry at each index has children.
export function hasChildrenOf(entries: readonly OutlineEntry[]): boolean[] {
  return entries.map((entry, index) => {
    const next = entries[index + 1];
    return next !== undefined && next.level > entry.level;
  });
}

// The entries a reader can see: an entry under a collapsed ancestor is hidden. The expansion set
// names the expanded entries by index; an entry with children and no entry in the set is collapsed.
export function visibleRows(
  entries: readonly OutlineEntry[],
  expanded: ReadonlySet<number>,
): BookmarkRow[] {
  const children = hasChildrenOf(entries);
  const rows: BookmarkRow[] = [];
  // The level of the collapsed entry that hides the entries after it, or null when none does.
  let hiddenBelow: number | null = null;
  entries.forEach((entry, index) => {
    if (hiddenBelow !== null && entry.level > hiddenBelow) return;
    hiddenBelow = null;
    const hasChildren = children[index] ?? false;
    const isExpanded = hasChildren && expanded.has(index);
    rows.push({ index, entry, hasChildren, expanded: isExpanded });
    if (hasChildren && !isExpanded) hiddenBelow = entry.level;
  });
  return rows;
}

// The expansion the file asks for: each entry flagged open starts expanded.
export function initialExpanded(entries: readonly OutlineEntry[]): Set<number> {
  const open = new Set<number>();
  entries.forEach((entry, index) => {
    if (entry.is_open) open.add(index);
  });
  return open;
}

// What a key does on the row of the flat outline at `index`, following the ARIA tree pattern: Up and
// Down move through the visible rows, Right opens a closed entry or steps into an open one, Left
// closes an open entry or moves to the parent, Home and End go to the first and last row, and Enter
// or Space goes to the entry's page.
export type BookmarkAction =
  | { readonly kind: 'focus'; readonly index: number }
  | { readonly kind: 'expand' | 'collapse'; readonly index: number }
  | { readonly kind: 'activate'; readonly index: number }
  // The edits (W5.2 S2): F2 renames, Delete removes, and Alt+Shift+Arrow moves (Up and Down reorder,
  // Right indents, Left outdents). Alt+Arrow alone stays with the browser and the app's Back and Forward.
  | { readonly kind: 'rename' | 'delete'; readonly index: number }
  | { readonly kind: 'move'; readonly index: number; readonly direction: MoveDirection }
  // Alt+Shift+N adds a bookmark after the row (W5.2 S3); a child add has no key (the toolbar's button).
  | { readonly kind: 'add'; readonly index: number }
  | { readonly kind: 'none' };

export interface KeyModifiers {
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  // The physical key (KeyboardEvent.code). Option+Shift+N makes a different `key` on macOS, so the
  // add key matches by code.
  readonly code?: string;
}

const NONE: BookmarkAction = { kind: 'none' };

const MOVE_KEYS: Readonly<Record<string, MoveDirection>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'in',
  ArrowLeft: 'out',
};

export function treeAction(
  rows: readonly BookmarkRow[],
  key: string,
  index: number,
  modifiers: KeyModifiers = {},
): BookmarkAction {
  const position = rows.findIndex((row) => row.index === index);
  const row = rows[position];
  if (row === undefined) return NONE;
  const focus = (target: BookmarkRow | undefined): BookmarkAction =>
    target === undefined ? NONE : { kind: 'focus', index: target.index };
  if (modifiers.alt) {
    if (modifiers.shift && !modifiers.ctrl && !modifiers.meta && modifiers.code === 'KeyN') {
      return { kind: 'add', index };
    }
    const direction = MOVE_KEYS[key];
    return modifiers.shift && direction !== undefined ? { kind: 'move', index, direction } : NONE;
  }
  const bare = !modifiers.shift && !modifiers.ctrl && !modifiers.meta;
  if (key === 'F2' && bare) return { kind: 'rename', index };
  if (key === 'Delete' && bare) return { kind: 'delete', index };
  switch (key) {
    case 'ArrowDown':
      return focus(rows[position + 1]);
    case 'ArrowUp':
      return focus(rows[position - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows[rows.length - 1]);
    case 'ArrowRight':
      if (row.hasChildren && !row.expanded) return { kind: 'expand', index };
      // An open entry's first child is the next visible row.
      return row.hasChildren ? focus(rows[position + 1]) : NONE;
    case 'ArrowLeft': {
      if (row.expanded) return { kind: 'collapse', index };
      // The parent is the nearest row above with a smaller level.
      for (let above = position - 1; above >= 0; above -= 1) {
        const candidate = rows[above];
        if (candidate !== undefined && candidate.entry.level < row.entry.level) {
          return focus(candidate);
        }
      }
      return NONE;
    }
    case 'Enter':
    case ' ':
      return { kind: 'activate', index };
    default:
      return NONE;
  }
}
