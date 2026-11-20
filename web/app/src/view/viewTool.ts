// The view tool of each open tab (W4.10): Select, or Hand, which pans the page with a drag. It is
// view state only: no RPC, no document change, no dirty flag, no undo step. Like navHistory it is
// module state, not persisted (a reload starts every tab on Select), and it lives here and not in
// the document view, because the view remounts on a tab switch and after each structure change.
import { useSyncExternalStore } from 'react';

export type ViewTool = 'select' | 'hand';

const tools = new Map<number, ViewTool>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function toolOf(tabId: number): ViewTool {
  return tools.get(tabId) ?? 'select';
}

// Sets the tab's tool. Setting the tool it already has changes nothing and notifies nobody.
export function setViewTool(tabId: number, tool: ViewTool): void {
  if (toolOf(tabId) === tool) return;
  tools.set(tabId, tool);
  notify();
}

// Drops a closed tab's tool. Harmless to skip, since an unknown tab reads as Select.
export function forgetViewTool(tabId: number): void {
  if (tools.delete(tabId)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The tab's tool; Select when the tab is unknown or there is no tab.
export function useViewTool(tabId: number | null): ViewTool {
  return useSyncExternalStore(
    subscribe,
    () => (tabId === null ? 'select' : toolOf(tabId)),
    () => 'select',
  );
}
