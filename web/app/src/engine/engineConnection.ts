// The engine session each open tab can show (W5.1a). A tab gets a session only when its document
// is open in the engine and the RPC client is connected (hello succeeded); until then the document
// view is not mounted for it. Nothing sets a session yet: the open wiring comes with the RPC
// session work, so this store is the seam that work fills in. The UI reads it, never the worker.
import { useSyncExternalStore } from 'react';
import type { Methods } from '../rpc/generated';

// The calls the document view makes. RpcClient satisfies this; tests pass a fake.
export interface PageRpc {
  call<M extends 'session.pages' | 'render.page'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

export interface EngineSession {
  readonly rpc: PageRpc;
  // The document handle the engine gave at session.open; every call names it.
  readonly handle: string;
}

const sessions = new Map<number, EngineSession>();
const listeners = new Set<() => void>();

export function setTabSession(tabId: number, session: EngineSession | null): void {
  if (session === null) sessions.delete(tabId);
  else sessions.set(tabId, session);
  for (const listener of listeners) listener();
}

export function getTabSession(tabId: number): EngineSession | null {
  return sessions.get(tabId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The session of the given tab, or null when there is no tab or the tab has none.
export function useTabSession(tabId: number | null): EngineSession | null {
  return useSyncExternalStore(
    subscribe,
    () => (tabId === null ? null : getTabSession(tabId)),
    () => null,
  );
}
