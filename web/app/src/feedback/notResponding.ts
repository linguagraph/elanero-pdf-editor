// The app's one "not responding" dialog state (W1.1 section 1, W4.4b). An RPC call that passes its
// deadline, or that runs the engine out of memory, reports its error here, once, for the whole app:
// the dialog is never opened per call. Wait closes it and leaves the engine running. Restart engine
// replaces the engine (W3.9) and reopens each document from its autosave copy, if there is one. A
// document that cannot come back is closed, so nothing keeps a handle of the old engine.
import { useSyncExternalStore } from 'react';
import type { EngineClient } from '../engine/engineConnection';
import { restartEngine, type OpenDocumentRef, type RestartResult } from '../engine/restart';
import { t } from '../i18n/t';
import {
  isNotRespondingError,
  notRespondingReason,
  type NotRespondingReason,
} from './NotRespondingDialog';
import type { EngineLoadStore } from './engineLoad';
import { jobProgress, type JobProgressStore } from './jobRun';
import { lostItemsText } from './lostWork';
import { toasts, type ToastStore } from './toasts';

// The engine the app talks to. The connection owns the worker: restart replaces it.
export interface RestartableEngine {
  // The load state of the engine: a failed load of the new engine ends the restart's wait.
  readonly store: EngineLoadStore;
  // Replaces the worker. False when the browser refuses the new one; the old engine keeps running.
  restart(): boolean;
  // Resolves with the RPC client once the new engine is ready. Rejects only when disposed.
  whenReady(): Promise<EngineClient>;
}

// The documents of the app, as the restart needs them.
export interface EngineSession {
  readonly engine: RestartableEngine;
  // Every document open in the engine, in the order they are reopened.
  readonly documents: readonly OpenDocumentRef[];
  // The autosave copy of a document, or undefined when it has none.
  bytesOf(documentId: string): Promise<ArrayBuffer | undefined>;
  // True when the document is encrypted or was opened with a password. Such a document is never
  // reopened from a copy (D2), so this is asked before bytesOf.
  isProtected(documentId: string): boolean;
  // Opens the copy in the restarted engine and points the document's tab at the new handle.
  reopen(document: OpenDocumentRef, bytes: ArrayBuffer, client: EngineClient): Promise<void>;
  // Removes a document that could not come back: its tab closes and its old handle and session
  // are detached, so no call reaches the terminated engine.
  lost(document: OpenDocumentRef): void;
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
  // are reopened or closed.
  restart(): Promise<void>;
  setSession(session: EngineSession | undefined): void;
}

export interface NotRespondingOptions {
  readonly restart?: (options: Parameters<typeof restartEngine>[0]) => RestartResult;
  readonly toasts?: ToastStore;
  // The running-job state. A job on the old engine is cancelled before the engine is replaced.
  readonly jobs?: JobProgressStore;
}

// Resolves with the client once the new engine is ready, or with undefined when its load fails.
// A failed load is kept by the load store for Try again; this wait ends with it, so restart() never
// hangs on an engine that will not load. Rejects only when the connection is disposed.
function untilReady(engine: RestartableEngine): Promise<EngineClient | undefined> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const settle = (action: () => void): void => {
      unsubscribe();
      action();
    };
    const failed = (): boolean => engine.store.getState().status === 'failed';
    unsubscribe = engine.store.subscribe(() => {
      if (failed()) settle(() => resolve(undefined));
    });
    if (failed()) {
      settle(() => resolve(undefined));
      return;
    }
    engine.whenReady().then(
      (client) => settle(() => resolve(client)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

export function createNotRespondingStore(options: NotRespondingOptions = {}): NotRespondingStore {
  const restart = options.restart ?? restartEngine;
  const toastStore = options.toasts ?? toasts;
  const jobs = options.jobs ?? jobProgress;
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
      // A running job holds a document of the old engine. It is cancelled through its abort path
      // first; when that fails the job still runs, so the engine is not replaced.
      let cancelledJob = false;
      if (jobs.getState().job !== undefined) {
        await jobs.cancel();
        if (jobs.getState().job !== undefined) {
          toastStore.push('error', t('engine.restart.busy'));
          return;
        }
        cancelledJob = true;
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
      let client: EngineClient | undefined;
      try {
        client = await untilReady(current.engine);
      } catch {
        // The connection was disposed: the page is going away, so nothing is reopened.
        return;
      }
      // Read after the wait: a tab closed or opened meanwhile is seen as it is now.
      const live = session;
      const documents = live?.documents ?? [];
      const jobNote = cancelledJob ? `${t('engine.restart.jobCancelled')} ` : '';

      if (client === undefined) {
        // The new engine did not load. Nothing of the old engine survives, so every document is
        // closed and named once.
        toastStore.push('error', t('engine.restart.failed'));
        if (live !== undefined) for (const document of documents) live.lost(document);
        if (documents.length > 0) {
          const names = documents.map((document) => document.name).join(', ');
          toastStore.push('error', t('engine.restart.lost', { names, items: lostItemsText() }));
        }
        return;
      }
      // The app went away (no session) while the engine loaded: there is nothing to reopen.
      if (live === undefined) return;

      const missing: OpenDocumentRef[] = [];
      const protectedDocs: OpenDocumentRef[] = [];
      for (const document of documents) {
        // Protection is checked before the copy is read: a protected document is never reopened
        // from a copy, even one that exists (D2).
        if (live.isProtected(document.id)) {
          protectedDocs.push(document);
          live.lost(document);
          continue;
        }
        const bytes = await live.bytesOf(document.id);
        if (bytes === undefined) {
          missing.push(document);
          live.lost(document);
          continue;
        }
        try {
          await live.reopen(document, bytes, client);
        } catch {
          missing.push(document);
          live.lost(document);
        }
      }
      // The undo history is lost on every restart, so the lost list is shown whether or not every
      // document came back. One message names every document that did not come back.
      const items = lostItemsText();
      const lost = [...missing, ...protectedDocs];
      if (lost.length === 0) {
        toastStore.push('success', `${jobNote}${t('engine.restart.done', { items })}`);
        return;
      }
      const names = lost.map((document) => document.name).join(', ');
      if (missing.length === 0) {
        toastStore.push('error', `${jobNote}${t('engine.restart.lost.protected', { names })}`);
      } else {
        toastStore.push('error', `${jobNote}${t('engine.restart.lost', { names, items })}`);
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
