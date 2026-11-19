// The bookmarks panel's expanded entries per tab (W5.2). Kept in memory only, like the open panel:
// a reload starts with the file's own flags. The panel's open state is the side-panel store's.
const expandedByTab = new Map<number, { count: number; expanded: Set<number> }>();

// The expanded entries of the tab for an outline of this many entries, or undefined when there are
// none saved for that outline. A different count means a different outline, so the file's own
// flags apply again.
export function expandedOf(tabId: number, count: number): Set<number> | undefined {
  const saved = expandedByTab.get(tabId);
  return saved !== undefined && saved.count === count ? saved.expanded : undefined;
}

export function setExpandedOf(tabId: number, count: number, expanded: Set<number>): void {
  expandedByTab.set(tabId, { count, expanded });
}

// Drops the expansion kept for a tab that closed (called by the document tabs).
export function forgetBookmarksTab(tabId: number): void {
  expandedByTab.delete(tabId);
}
