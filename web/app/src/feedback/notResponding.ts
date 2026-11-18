// The app's one "not responding" dialog state (W1.1 section 1, W4.4b). An RPC call that passes its
// deadline reports its error here, once, for the whole app: the dialog is never opened per call.
// Wait closes it and leaves the engine running. Restart engine stops the old engine and starts a
// new one through restartEngine (W3.9), then reopens each document the caller has bytes for.
import { useSyncExternalStore } from 'react';
import { restartEngine, type OpenDocumentRef, type RestartResult } from '../engine/restart';
import type { StartOptions, WorkerClient } from '../engine/start';
import { t } from '../i18n/t';
import { isNotRespondingError } from './NotRespondingDialog';
import { lostItemsText } from './lostWork';
import { toasts, type ToastStore } from './toasts';

// The engine the app is talking to. Whoever starts the engine registers it; nothing in the app
// does yet, so the restart has no session and says so.
export interface EngineSession {
  readonly worker: WorkerClient;
  readonly start: StartOptions;
  // Every document open in the engine, in the order they are reopened.
  readonly documents: readonly OpenDocumentRef[];
  // The last autosave bytes of a document, or undefined when the caller does not have them.
  bytesOf(documentId: string): ArrayBuffer | undefined;
  // Opens one document in the new engine.
  reopen(document: OpenDocumentRef, bytes: ArrayBuffer, worker: WorkerClient): void;
}

export interface NotRespondingState {
  // The timeout the dialog shows, or undefined when the dialog is closed.
  readonly error: unknown;
}

export interface NotRespondingStore {
  getState(): NotRespondingState;
  subscribe(listener: () => void): () => void;
  // Opens the dialog for a deadline error. Any other error, or a second report while the dialog
  // is open, changes nothing. Returns true when the dialog opened.
  report(error: unknown): boolean;
  // Closes the dialog. The call that timed out keeps waiting; nothing is restarted.
  wait(): void;
  // Closes the dialog and restarts the engine (see the file comment).
  restart(): void;
  setSession(session: EngineSession | undefined): void;
}

export interface NotRespondingOptions {
  readonly restart?: (options: Parameters<typeof restartEngine>[0]) => RestartResult;
  readonly toasts?: ToastStore;
}

export function createNotRespondingStore(options: NotRespondingOptions = {}): NotRespondingStore {
  const restart = options.restart ?? restartEngine;
  const toastStore = options.toasts ?? toasts;
  let state: NotRespondingState = { error: undefined };
  let session: EngineSession | undefined;
  const listeners = new Set<() => void>();

  const update = (next: NotRespondingState): void => {
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
    report(error) {
      if (state.error !== undefined || !isNotRespondingError(error)) return false;
      update({ error });
      return true;
    },
    wait() {
      if (state.error !== undefined) update({ error: undefined });
    },
    restart() {
      update({ error: undefined });
      if (session === undefined) {
        toastStore.push('info', t('engine.restart.unavailable'));
        return;
      }
      const current = session;
      const result = restart({
        current: current.worker,
        start: current.start,
        documents: current.documents,
      });
      if (!result.ok) {
        toastStore.push('error', t('engine.restart.failed'));
        return;
      }
      // The old engine is terminated by restartEngine; the session now points at the new one.
      session = { ...current, worker: result.worker };
      const missing: OpenDocumentRef[] = [];
      for (const document of result.reopen) {
        const bytes = current.bytesOf(document.id);
        if (bytes === undefined) missing.push(document);
        else current.reopen(document, bytes, result.worker);
      }
      // The undo history is lost on every restart, so the lost list is shown whether or not every
      // document came back.
      const items = lostItemsText();
      if (missing.length === 0) {
        toastStore.push('success', t('engine.restart.done', { items }));
      } else {
        const names = missing.map((document) => document.name).join(', ');
        toastStore.push('error', t('engine.restart.lost', { names, items }));
      }
    },
    setSession(next) {
      session = next;
    },
  };
}

// The app's store. The engine connection reports timeouts here; App mounts the dialog.
export const notResponding: NotRespondingStore = createNotRespondingStore();

export function useNotResponding(store: NotRespondingStore = notResponding): NotRespondingState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
