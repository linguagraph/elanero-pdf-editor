// Whether the search panel is open, per tab (W5.4). Kept in memory only, like the thumbnails panel:
// a reload starts with every panel closed.
import { useSyncExternalStore } from 'react';

const open = new Set<number>();
const listeners = new Set<() => void>();

export function isSearchOpen(tabId: number): boolean {
  return open.has(tabId);
}

export function setSearchOpen(tabId: number, value: boolean): void {
  if (value === open.has(tabId)) return;
  if (value) open.add(tabId);
  else open.delete(tabId);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The open state of the given tab; false when there is no tab.
export function useSearchOpen(tabId: number | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabId !== null && isSearchOpen(tabId),
    () => false,
  );
}
