// The navigation history of each open tab, kept in memory (W5.3). Like the thumbnails open state,
// it is module state: a reload starts every tab with an empty history. The document view remounts
// when the tab changes, so the history lives here and not in the view.
import { useSyncExternalStore } from 'react';
import { EMPTY_HISTORY, type NavHistory, recordJump, stepHistory } from './navigation';

const histories = new Map<number, NavHistory>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function historyOf(tabId: number): NavHistory {
  return histories.get(tabId) ?? EMPTY_HISTORY;
}

// Records a jump from one zero-based page to another in the tab's history.
export function recordTabJump(tabId: number, from: number, to: number): void {
  const before = historyOf(tabId);
  const after = recordJump(before, from, to);
  if (after === before) return;
  histories.set(tabId, after);
  notify();
}

// Moves the tab's history one entry back (-1) or forward (1). Returns the page to show, or null.
export function stepTabHistory(tabId: number, direction: -1 | 1): number | null {
  const step = stepHistory(historyOf(tabId), direction);
  if (step === null) return null;
  histories.set(tabId, step.history);
  notify();
  return step.page;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The tab's history; the empty one when there is no tab.
export function useNavHistory(tabId: number | null): NavHistory {
  return useSyncExternalStore(
    subscribe,
    () => (tabId === null ? EMPTY_HISTORY : historyOf(tabId)),
    () => EMPTY_HISTORY,
  );
}
