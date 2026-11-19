// Whether the page organizer panel is open, per tab (W6.1). In memory only, like the thumbnails
// panel's state: a reload starts with every panel closed.
import { useSyncExternalStore } from 'react';

const open = new Set<number>();
const listeners = new Set<() => void>();

export function setOrganizerOpen(tabId: number, value: boolean): void {
  if (value === open.has(tabId)) return;
  if (value) open.add(tabId);
  else open.delete(tabId);
  for (const listener of [...listeners]) listener();
}

export function isOrganizerOpen(tabId: number): boolean {
  return open.has(tabId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The open state of the given tab; false when there is no tab.
export function useOrganizerOpen(tabId: number | null): boolean {
  return useSyncExternalStore(
    subscribe,
    () => tabId !== null && open.has(tabId),
    () => false,
  );
}
