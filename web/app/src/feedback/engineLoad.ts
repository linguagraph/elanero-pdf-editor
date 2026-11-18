// The engine load state behind the loading screen (W1.6 section 10, W3.1 stages). The engine start
// reports each stage event and any failure here; the loading screen only reads. Retry calls the
// starter that the engine start registered, so this file never starts a worker itself.
import { useSyncExternalStore } from 'react';
import type { EngineLoadError } from '../engine/errors';
import type { FailedStage, Stage } from '../engine/protocol';

export type LoadState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly stage: Stage }
  | { readonly status: 'failed'; readonly stage: FailedStage }
  | { readonly status: 'ready' };

export interface EngineLoadStore {
  getState(): LoadState;
  subscribe(listener: () => void): () => void;
  stage(stage: Stage): void;
  fail(error: EngineLoadError): void;
  setStarter(start: (() => void) | undefined): void;
  // Starts the load again after a failure. Does nothing when no starter is registered.
  retry(): void;
}

export function createEngineLoadStore(): EngineLoadStore {
  let state: LoadState = { status: 'idle' };
  let starter: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const update = (next: LoadState): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stage(stage) {
      update(stage === 'ready' ? { status: 'ready' } : { status: 'loading', stage });
    },
    fail(error) {
      update({ status: 'failed', stage: error.stage });
    },
    setStarter(start) {
      starter = start;
    },
    retry() {
      if (state.status !== 'failed' || starter === undefined) return;
      update({ status: 'loading', stage: 'pyodide' });
      starter();
    },
  };
}

export const engineLoad: EngineLoadStore = createEngineLoadStore();

export function useEngineLoadState(store: EngineLoadStore = engineLoad): LoadState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
