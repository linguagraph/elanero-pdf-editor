// Re-renders a component when a shortcut changes (here or in another tab), so the keys it shows are
// the keys the web binds. Components call this, then read effectiveKeys during render.
import { useSyncExternalStore } from 'react';
import { bindingsVersion, subscribeBindings } from './bindings';

export function useShortcutBindings(): number {
  return useSyncExternalStore(subscribeBindings, bindingsVersion);
}
