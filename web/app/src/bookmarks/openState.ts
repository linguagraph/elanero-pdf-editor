// The bookmarks panel's state per tab (W5.2): whether it is open, and which entries are expanded.
// Kept in memory only, like the thumbnails panel: a reload starts with every panel closed.
import { useSyncExternalStore } from 'react';

const open = new Set<number>();
const expandedByTab = new Map<number, Set<number>>();
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

// The expanded entries of the tab, or undefined when the panel has not set them yet.
export function expandedOf(tabId: number): Set<number> | undefined {
  return expandedByTab.get(tabId);
}

export function setExpandedOf(tabId: number, expanded: Set<number>): void {
  expandedByTab.set(tabId, expanded);
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
