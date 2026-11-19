// The bookmarks tree, worked out from the flat outline the engine returns (W5.2). Each entry carries
// its level; an entry's children are the entries after it with a greater level, up to the next entry
// at its own level or above. Pure functions, so the panel and the tests share them.
import type { OutlineEntry } from '../rpc/generated';

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
