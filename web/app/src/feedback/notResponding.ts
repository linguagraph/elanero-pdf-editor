// The app's one "not responding" dialog state (W1.1 section 1, W4.4b). An RPC call that passes its
// deadline, or that runs the engine out of memory, reports its error here, once, for the whole app:
// the dialog is never opened per call. Wait closes it and leaves the engine running. Restart engine
// replaces the engine (W3.9) and reopens each document from its autosave copy, if there is one.
import { useSyncExternalStore } from 'react';
import type { EngineClient } from '../engine/engineConnection';
import { restartEngine, type OpenDocumentRef, type RestartResult } from '../engine/restart';
import { t } from '../i18n/t';
import {
  isNotRespondingError,
  notRespondingReason,
  type NotRespondingReason,
} from './NotRespondingDialog';
import { lostItemsText } from './lostWork';
import { toasts, type ToastStore } from './toasts';

// The engine the app talks to. The connection owns the worker: restart replaces it.
export interface RestartableEngine {
  // Replaces the worker. False when the browser refuses the new one; the old engine keeps running.
  restart(): boolean;
  // Resolves with the RPC client once the new engine is ready.
  whenReady(): Promise<EngineClient>;
}

// The documents of the app, as the restart needs them.
export interface EngineSession {
  readonly engine: RestartableEngine;
  // Every document open in the engine, in the order they are reopened.
  readonly documents: readonly OpenDocumentRef[];
  // The autosave copy of a document, or undefined when it has none.
  bytesOf(documentId: string): Promise<ArrayBuffer | undefined>;
  // True when the document was not copied because it is password-protected (D2).
  isProtected(documentId: string): boolean;
  // Opens the copy in the restarted engine and points the document's tab at the new handle.
  reopen(document: OpenDocumentRef, bytes: ArrayBuffer, client: EngineClient): Promise<void>;
}

export interface NotRespondingState {
  // The failure the dialog shows, or undefined when the dialog is closed.
  readonly error: unknown;
  // Which text the dialog shows: a timeout, or the engine running out of memory.
  readonly reason: NotRespondingReason | undefined;
}

export interface NotRespondingStore {
  getState(): NotRespondingState;
  subscribe(listener: () => void): () => void;
  // Opens the dialog for a deadline or out-of-memory error. Any other error, or a second report
  // while the dialog is open, changes nothing. Returns true when the dialog opened.
  report(error: unknown): boolean;
  // Closes the dialog. The call that failed keeps waiting; nothing is restarted.
  wait(): void;
  // Closes the dialog and restarts the engine (see the file comment). Resolves when the documents
  // are reopened.
  restart(): Promise<void>;
  setSession(session: EngineSession | undefined): void;
}

export interface NotRespondingOptions {
  readonly restart?: (options: Parameters<typeof restartEngine>[0]) => RestartResult;
  readonly toasts?: ToastStore;
}

export function createNotRespondingStore(options: NotRespondingOptions = {}): NotRespondingStore {
  const restart = options.restart ?? restartEngine;
  const toastStore = options.toasts ?? toasts;
  let state: NotRespondingState = { error: undefined, reason: undefined };
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
      update({ error, reason: notRespondingReason(error) });
      return true;
    },
    wait() {
      if (state.error !== undefined) update({ error: undefined, reason: undefined });
    },
    async restart() {
      update({ error: undefined, reason: undefined });
      const current = session;
      if (current === undefined) {
        toastStore.push('info', t('engine.restart.unavailable'));
        return;
      }
      const result: RestartResult = restart({
        replaceEngine: () => current.engine.restart(),
        documents: current.documents,
      });
      if (!result.ok) {
        toastStore.push('error', t('engine.restart.failed'));
        return;
      }
      // The new engine loads like a first start; the documents wait for it.
      let client: EngineClient;
      try {
        client = await current.engine.whenReady();
      } catch {
        // The connection was disposed: the page is going away, so nothing is reopened.
        return;
      }
      const missing: OpenDocumentRef[] = [];
      const protectedDocs: OpenDocumentRef[] = [];
      for (const document of result.reopen) {
        const bytes = await current.bytesOf(document.id);
        if (bytes === undefined) {
          (current.isProtected(document.id) ? protectedDocs : missing).push(document);
          continue;
        }
        try {
          await current.reopen(document, bytes, client);
        } catch {
          missing.push(document);
        }
      }
      // The undo history is lost on every restart, so the lost list is shown whether or not every
      // document came back.
      const items = lostItemsText();
      if (missing.length === 0 && protectedDocs.length === 0) {
        toastStore.push('success', t('engine.restart.done', { items }));
        return;
      }
      if (missing.length > 0) {
        const names = missing.map((document) => document.name).join(', ');
        toastStore.push('error', t('engine.restart.lost', { names, items }));
      }
      if (protectedDocs.length > 0) {
        const names = protectedDocs.map((document) => document.name).join(', ');
        toastStore.push('error', t('engine.restart.lost.protected', { names }));
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
