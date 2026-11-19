// Whether the thumbnails panel is open, per tab (W5.2). Kept in memory only: a reload starts with
// every panel closed, as the desktop does for a new window. Module state, like the tab sessions.
import { useSyncExternalStore } from 'react';

const open = new Set<number>();
const listeners = new Set<() => void>();

export function isThumbnailsOpen(tabId: number): boolean {
  return open.has(tabId);
}

export function setThumbnailsOpen(tabId: number, value: boolean): void {
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
export function useThumbnailsOpen(tabId: number | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabId !== null && isThumbnailsOpen(tabId),
    () => false,
  );
}
