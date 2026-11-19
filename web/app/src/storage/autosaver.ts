// The autosave scheduler (W3.9 S2, W1.1 section 6). For each open document that has unsaved changes
// it asks the engine for a snapshot (save.autosave_bytes) and writes it to the browser's private
// storage, at most once a minute and only while the page is idle. A clean document has no copy: the
// copy is deleted when the document is closed, when it becomes clean (saved), and when the page is
// left. A failure to autosave is a warning, never an error, and the user's work is never touched:
// the engine copy is only read, and nothing here changes the document.
import type { EngineClient } from '../engine/engineConnection';
import { RpcError } from '../rpc/client';
import type { AutosaveStore, WriteOutcome } from './autosaveStore';

// W1.1 section 6: a copy at most once a minute while the document is dirty.
export const AUTOSAVE_INTERVAL_MS = 60_000;
// A busy engine (a task is running) is asked again soon, so the copy is not a minute late.
export const BUSY_RETRY_MS = 5_000;
// After a failure (no space, a write error, a missing client) the next try waits a full interval.
export const ERROR_RETRY_MS = AUTOSAVE_INTERVAL_MS;
// The idle callback waits at most this long, so a busy page still gets its copy.
export const IDLE_TIMEOUT_MS = 5_000;

// The warnings the autosaver can raise. Each is shown once per page load.
export type AutosaveWarning = 'unavailable' | 'noSpace' | 'tooLarge';

// The document state the autosaver needs: the tab's id, name, handle, page count and dirty flag.
export interface AutosaveDocument {
  readonly id: number;
  readonly name: string;
  readonly handle: string;
  readonly pages: number;
  readonly dirty: boolean;
}

export interface Autosaver {
  // Brings the scheduler in step with the open documents. A dirty document is scheduled; a document
  // that is clean, or no longer open, has its copy deleted.
  sync(docs: readonly AutosaveDocument[]): void;
  // True when the document (by tab id) has no copy because it is password-protected (D2).
  isProtected(docId: number): boolean;
  // Stops tracking a document whose tab a restart is closing because it could not be reopened. Its
  // copy is the recovery copy, so it is kept in the store: nothing is deleted (W3.9 S3).
  release(docId: number): void;
}

// Re-syncs when the page comes back from the back-forward cache (pageshow with persisted set). The
// cached page may have come back without its scheduled writes, so the scheduler is brought in step
// again. Nothing is deleted on pagehide: a copy is removed only when its document closes or becomes
// clean, so a restore (or a crash) still finds it. Returns the function that stops the listener.
export function watchPageShow(target: EventTarget, resync: () => void): () => void {
  const onPageShow = (event: Event): void => {
    if ((event as Event & { persisted?: boolean }).persisted === true) resync();
  };
  target.addEventListener('pageshow', onPageShow);
  return () => target.removeEventListener('pageshow', onPageShow);
}

export interface AutosaverOptions {
  // This browser tab's id: the folder the copies go into (tabId.ts).
  readonly tabId: string;
  readonly store: AutosaveStore;
  // The engine client, or undefined while the engine is not ready.
  readonly client: () => Pick<EngineClient, 'call'> | undefined;
  readonly warn: (warning: AutosaveWarning) => void;
  // Injected by the tests; the defaults are the browser's clock and timers.
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly idle?: (run: () => void) => void;
}

interface Entry {
  doc: AutosaveDocument;
  scheduled: boolean;
  timer: unknown;
  running: boolean;
  lastWrite: number | undefined;
  // Why this document is not copied for its current handle ("protected" or "too_large").
  disabled: string | undefined;
  // Set once the document is no longer tracked; a write still in flight then writes nothing.
  gone: boolean;
}

function defaultIdle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  if (typeof ric === 'function') {
    (ric as (cb: () => void, options: { timeout: number }) => void)(run, {
      timeout: IDLE_TIMEOUT_MS,
    });
  } else {
    setTimeout(run, 0);
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'BUSY';
}

function isTooLarge(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'FILE_TOO_LARGE';
}

export function createAutosaver(options: AutosaverOptions): Autosaver {
  const { tabId, store, client, warn } = options;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const idle = options.idle ?? defaultIdle;

  const entries = new Map<number, Entry>();
  const warned = new Set<AutosaveWarning>();
  let storeOk: Promise<boolean> | undefined;
  let off = false;
  // Every store operation runs one at a time, in call order. A delete queued after a write therefore
  // always removes what that write made, and no write lands after its document was closed.
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(op: () => Promise<T>): Promise<T> {
    const next = chain.then(op);
    chain = next.catch(() => undefined);
    return next;
  }

  function warnOnce(warning: AutosaveWarning): void {
    if (warned.has(warning)) return;
    warned.add(warning);
    warn(warning);
  }

  function cancel(entry: Entry): void {
    if (entry.scheduled) clearTimer(entry.timer);
    entry.scheduled = false;
    entry.timer = undefined;
  }

  // The browser cannot keep copies: stop for the rest of the page load, and say so once. Retrying
  // would only repeat the same failure, so the user is told rather than left unprotected in silence.
  function stopCopying(): void {
    off = true;
    warnOnce('unavailable');
    for (const entry of entries.values()) cancel(entry);
  }

  function schedule(entry: Entry, delay: number): void {
    if (off || entry.scheduled || entry.running || entry.gone) return;
    if (entry.disabled !== undefined || !entry.doc.dirty) return;
    entry.scheduled = true;
    entry.timer = setTimer(() => {
      entry.scheduled = false;
      idle(() => {
        void run(entry);
      });
    }, delay);
  }

  // Stops tracking a document and deletes its copy. The delete is queued, so it runs after any write
  // of that document that is already in progress.
  function forget(id: number, entry: Entry): void {
    entry.gone = true;
    cancel(entry);
    entries.delete(id);
    void serial(() => store.remove(tabId, id));
  }

  async function run(entry: Entry): Promise<void> {
    if (entry.gone || off || entry.running || !entry.doc.dirty || entry.disabled !== undefined) {
      return;
    }
    storeOk ??= store.available();
    if (!(await storeOk)) {
      stopCopying();
      return;
    }
    const sinceWrite = entry.lastWrite === undefined ? undefined : now() - entry.lastWrite;
    if (sinceWrite !== undefined && sinceWrite < AUTOSAVE_INTERVAL_MS) {
      schedule(entry, AUTOSAVE_INTERVAL_MS - sinceWrite);
      return;
    }
    const rpc = client();
    if (rpc === undefined) {
      schedule(entry, ERROR_RETRY_MS);
      return;
    }
    const doc = entry.doc;
    entry.running = true;
    let delay = AUTOSAVE_INTERVAL_MS;
    try {
      const copy = await rpc.call('save.autosave_bytes', { handle: doc.handle });
      if (copy.skipped !== null) {
        // A protected document never reaches the browser's storage; a document over the cap is
        // not copied at all. Neither is retried until the handle changes.
        entry.disabled = copy.skipped;
        if (copy.skipped === 'too_large') warnOnce('tooLarge');
        void serial(() => store.remove(tabId, doc.id));
        return;
      }
      const outcome: WriteOutcome | 'gone' = await serial(async () => {
        if (entry.gone) return 'gone';
        return store.write(tabId, doc.id, copy.data, {
          name: doc.name,
          time: new Date(now()).toISOString(),
          pages: doc.pages,
        });
      });
      if (outcome === 'gone') return;
      if (outcome === 'written') {
        entry.lastWrite = now();
      } else if (outcome === 'unsupported') {
        stopCopying();
        return;
      } else {
        // A full disk has its own message. Any other failure gets the unavailable message, once,
        // and the copy is tried again after a full interval.
        warnOnce(outcome === 'no-space' ? 'noSpace' : 'unavailable');
        delay = ERROR_RETRY_MS;
      }
    } catch (error: unknown) {
      if (isTooLarge(error)) {
        entry.disabled = 'too_large';
        warnOnce('tooLarge');
        return;
      }
      delay = isBusy(error) ? BUSY_RETRY_MS : ERROR_RETRY_MS;
    } finally {
      entry.running = false;
    }
    if (!entry.gone) schedule(entry, delay);
  }

  return {
    isProtected(docId) {
      return entries.get(docId)?.disabled === 'protected';
    },

    release(docId) {
      const entry = entries.get(docId);
      if (entry === undefined) return;
      // Unlike forget, no delete is queued: a write still in flight is dropped by the gone check.
      entry.gone = true;
      cancel(entry);
      entries.delete(docId);
    },

    sync(docs) {
      const present = new Set<number>();
      for (const doc of docs) {
        present.add(doc.id);
        const existing = entries.get(doc.id);
        if (!doc.dirty) {
          // Clean (saved, or never edited): there is nothing to restore, so no copy is kept.
          if (existing !== undefined) forget(doc.id, existing);
          continue;
        }
        let entry = existing;
        if (entry === undefined) {
          entry = {
            doc,
            scheduled: false,
            timer: undefined,
            running: false,
            lastWrite: undefined,
            disabled: undefined,
            gone: false,
          };
          entries.set(doc.id, entry);
        } else {
          // A reopened document (after a restart) has a new handle, so the engine is asked again.
          if (entry.doc.handle !== doc.handle) entry.disabled = undefined;
          entry.doc = doc;
        }
        schedule(entry, 0);
      }
      for (const [id, entry] of [...entries]) {
        if (!present.has(id)) forget(id, entry);
      }
    },
  };
}
