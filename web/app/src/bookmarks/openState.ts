// The bookmarks panel's state per tab (W5.2): whether it is open, and which entries are expanded.
// Kept in memory only, like the thumbnails panel: a reload starts with every panel closed.
import { useSyncExternalStore } from 'react';

const open = new Set<number>();
// The expansion of a tab, with the outline's entry count it was made for: a different count means
// a different outline, so the file's own flags apply again.
const expandedByTab = new Map<number, { count: number; expanded: Set<number> }>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function isBookmarksOpen(tabId: number): boolean {
  return open.has(tabId);
}

export function setBookmarksOpen(tabId: number, value: boolean): void {
  if (value === open.has(tabId)) return;
  if (value) open.add(tabId);
  else open.delete(tabId);
  notify();
}

// The expanded entries of the tab for an outline of this many entries, or undefined when there are
// none saved for that outline.
export function expandedOf(tabId: number, count: number): Set<number> | undefined {
  const saved = expandedByTab.get(tabId);
  return saved !== undefined && saved.count === count ? saved.expanded : undefined;
}

export function setExpandedOf(tabId: number, count: number, expanded: Set<number>): void {
  expandedByTab.set(tabId, { count, expanded });
}

// Drops everything kept for a tab that closed (called by the document tabs).
export function forgetBookmarksTab(tabId: number): void {
  expandedByTab.delete(tabId);
  if (open.delete(tabId)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The open state of the given tab; false when there is no tab.
export function useBookmarksOpen(tabId: number | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabId !== null && isBookmarksOpen(tabId),
    () => false,
  );
}
