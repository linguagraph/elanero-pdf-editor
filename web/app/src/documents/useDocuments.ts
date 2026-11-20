// The document state the app shell reads (W4.2b, W3.1): the tabs, the recent files and the start
// page. A chosen PDF is opened through the engine's session.open; its tab is added only when the
// engine has opened it. Closing a tab calls session.close. Everything the user reads comes
// through t().
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { forgetBookmarksTab } from '../bookmarks/expansion';
import {
  type EngineClient,
  type EngineConnection,
  setTabSession,
} from '../engine/engineConnection';
import { memoryWarner } from '../feedback/memoryWarning';
import { notResponding } from '../feedback/notResponding';
import { reportRpcError, toasts } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { addRecentFile, readRecentFiles, type RecentFile } from '../recent/recentFiles';
import { type AutosaveWarning, createAutosaver, watchPageShow } from '../storage/autosaver';
import { createAutosaveStore } from '../storage/autosaveStore';
import { browserTabId } from '../storage/tabId';
import {
  activateTab,
  addTab,
  applyDocState,
  closeTab as closeTabState,
  EMPTY_TABS,
  hasDirtyTab,
  replaceHandle,
  setPageCount,
  type TabState,
} from '../tabs/tabState';
import { restartSession } from './engineSession';
import { asRpcError, openFile, sizeRefusal } from './openFile';
import { passwordPrompt } from './passwordRequest';
import { guardUnload } from './unloadGuard';

// The message for each autosave warning. The autosaver raises each one once per page load.
const AUTOSAVE_MESSAGES: Record<AutosaveWarning, MessageId> = {
  unavailable: 'autosave.unavailable',
  noSpace: 'autosave.noSpace',
  tooLarge: 'autosave.tooLarge',
};

// A file counts as a PDF by its type, or by its name when the browser gives no type.
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// The most file bytes read ahead while the engine loads (W3.1). This is a total across all the
// queued files, not a limit per file. A file that would go past it is read when its turn comes, so
// a big file is not held in memory twice.
export const PREFETCH_MAX_BYTES = 256 * 1024 * 1024;

// A file picked while the engine loads, shown on the start page until its turn comes.
export interface PendingOpen {
  readonly id: number;
  readonly name: string;
}

interface QueuedOpen {
  readonly id: number;
  readonly file: File;
  // False for a file picked after the engine was ready: it is not listed, it just waits its turn.
  readonly listed: boolean;
  // The bytes read ahead, or undefined when the file is read at its turn.
  readonly prefetched: Promise<ArrayBuffer> | undefined;
}

// Gives back a queued file's share of the read-ahead budget, when it leaves the queue.
function releaseBudget(budget: { current: number }, entry: QueuedOpen): void {
  if (entry.prefetched !== undefined) budget.current -= entry.file.size;
}

export interface Documents {
  readonly tabs: TabState;
  readonly recent: readonly RecentFile[];
  // True when the start page is shown next to the tabs (Open Recent asks for it).
  readonly showStart: boolean;
  // The name of a recent file the user picked, so the start page can say which one to pick again.
  readonly pickHint: string | null;
  // The files picked while the engine loads, in the order they will open.
  readonly pending: readonly PendingOpen[];
  readonly inputRef: RefObject<HTMLInputElement | null>;
  openFiles(files: readonly File[]): void;
  // Drops a file that is still waiting for the engine. A file already opening can't be dropped.
  cancelPending(id: number): void;
  openPicker(hintName?: string): void;
  showStartPage(): void;
  selectTab(id: number): void;
  closeTab(id: number): void;
  // Keeps a tab's page count in step with the engine after an organizer change.
  setPages(id: number, pages: number): void;
}

export function useDocuments(engine: EngineConnection): Documents {
  const [tabs, setTabs] = useState<TabState>(EMPTY_TABS);
  // The latest tab state, updated at once on every change. The open loop reads the id of the tab it
  // has just added from here, which a state updater cannot give it synchronously.
  const tabsRef = useRef<TabState>(EMPTY_TABS);
  const commitTabs = useCallback((update: (state: TabState) => TabState) => {
    tabsRef.current = update(tabsRef.current);
    setTabs(tabsRef.current);
  }, []);
  const [recent, setRecent] = useState<RecentFile[]>(() => readRecentFiles());
  const [showStart, setShowStart] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const [pending, setPending] = useState<readonly PendingOpen[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // The files waiting for their turn, in pick order. Only one drain loop runs at a time, so the
  // files open one after another: each may ask for a password, and the dialog shows one request at a
  // time.
  const queueRef = useRef<QueuedOpen[]>([]);
  const drainingRef = useRef(false);
  const nextQueueIdRef = useRef(1);
  const prefetchBudgetRef = useRef({ current: 0 });
  const dirty = hasDirtyTab(tabs);
  // The autosave copies of this page load (W3.9 S2). One scheduler per page; it is held in state
  // so the effects below see the same instance.
  const [autosaveStore] = useState(() => createAutosaveStore());
  const [autosaver] = useState(() =>
    createAutosaver({
      tabId: browserTabId(),
      store: autosaveStore,
      client: () => engine.client(),
      warn: (warning) => toasts.push('warning', t(AUTOSAVE_MESSAGES[warning])),
    }),
  );

  // The restart reopens each document from its autosave copy (W3.9 S3). The session is rebuilt
  // with the tabs, so a restart always sees the documents that are open now.
  useEffect(() => {
    notResponding.setSession(
      restartSession({
        engine,
        tabs: tabs.tabs,
        tabId: browserTabId(),
        store: autosaveStore,
        // Encrypted by its open result, or copied as protected by the autosaver (D2).
        isProtected: (id) =>
          tabs.tabs.some((tab) => tab.id === id && tab.encrypted) || autosaver.isProtected(id),
        // The live tab list, not the snapshot above: a tab closed during the restart is seen.
        isOpen: (id) => tabsRef.current.tabs.some((tab) => tab.id === id),
        reopened: (id, client, opened) => {
          commitTabs((state) => replaceHandle(state, id, opened.handle, opened.pages));
          setTabSession(id, { rpc: client, handle: opened.handle });
        },
        // A document that could not come back: its tab closes and its old session is detached.
        // The copy stays in the store: it is the recovery copy of a document the restart could not
        // reopen, so the autosaver must not delete it when the tab goes (W3.9 S3).
        lost: (id) => {
          autosaver.release(id);
          commitTabs((state) => closeTabState(state, id));
          setTabSession(id, null);
          forgetBookmarksTab(id);
        },
      }),
    );
    return () => notResponding.setSession(undefined);
  }, [engine, autosaver, autosaveStore, tabs, commitTabs]);

  // The engine's state events keep each tab's dirty flag, undo state and busy flag in step with the
  // document (W4.8 S1). A state for a handle no tab holds is ignored by applyDocState.
  useEffect(
    () =>
      engine.onEvents((events) => {
        for (const event of events) {
          if (event.kind !== 'state') continue;
          commitTabs((state) => applyDocState(state, event.handle, event.state));
        }
      }),
    [engine, commitTabs],
  );

  // Warn before the page closes while a document has unsaved changes.
  useEffect(() => (dirty ? guardUnload(window) : undefined), [dirty]);

  // Keeps the autosave copies in step with the open tabs: a dirty tab is copied, and a closed or
  // clean tab loses its copy. A restore from the back-forward cache re-syncs the same way. Leaving
  // the page deletes nothing: the copies are for a restore after a crash or a cache restore.
  useEffect(() => {
    autosaver.sync(tabs.tabs);
    return watchPageShow(window, () => autosaver.sync(tabs.tabs));
  }, [autosaver, tabs]);

  const showPending = useCallback(() => {
    setPending(
      queueRef.current
        .filter((entry) => entry.listed)
        .map((entry) => ({ id: entry.id, name: entry.file.name })),
    );
  }, []);

  const openEntry = useCallback(
    async (client: EngineClient, entry: QueuedOpen) => {
      const { file } = entry;
      let firstBytes: ArrayBuffer | undefined;
      if (entry.prefetched !== undefined) {
        try {
          firstBytes = await entry.prefetched;
        } catch (error) {
          reportRpcError(toasts, asRpcError(error));
          return;
        }
      }
      const outcome = await openFile(client, file, (name) => passwordPrompt.ask(name), firstBytes);
      if (outcome.status === 'cancelled') return;
      if (outcome.status === 'failed') {
        reportRpcError(toasts, outcome.error);
        return;
      }
      const { handle, pages, warning } = outcome.result;
      if (warning !== null) toasts.push('info', t('open.largeFile', { name: file.name }));
      // The tab id is the one addTab gives the new tab. Its session lets the document view mount.
      const id = tabsRef.current.nextId;
      const { encrypted, has_signatures: signed } = outcome.result.info;
      commitTabs((state) => addTab(state, { name: file.name, handle, pages, encrypted, signed }));
      setTabSession(id, { rpc: client, handle });
      void memoryWarner.check(client, 'open');
      setRecent(addRecentFile(file.name));
      setShowStart(false);
      setPickHint(null);
    },
    [commitTabs],
  );

  // Opens the queue once the engine is ready. A dispose rejects the wait: the queue is then dropped
  // without a message, since the page is going away.
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      let client: EngineClient;
      try {
        client = await engine.whenReady();
      } catch {
        for (const entry of queueRef.current) releaseBudget(prefetchBudgetRef.current, entry);
        queueRef.current = [];
        showPending();
        return;
      }
      for (;;) {
        const [entry, ...rest] = queueRef.current;
        if (entry === undefined) return;
        queueRef.current = rest;
        releaseBudget(prefetchBudgetRef.current, entry);
        showPending();
        try {
          await openEntry(client, entry);
        } catch (error) {
          // A failure after the open (recording the tab, the session) is reported like any other
          // open failure. It must not stop the drain: the files behind it still open.
          reportRpcError(toasts, asRpcError(error));
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [engine, openEntry, showPending]);

  const openFiles = useCallback(
    (files: readonly File[]) => {
      const pdfs = files.filter(isPdfFile);
      const others = files.filter((file) => !isPdfFile(file));
      if (others.length > 0) {
        toasts.push('error', t('open.notPdf', { name: others[0]?.name ?? '' }));
      }
      if (pdfs.length === 0) return;
      const ready = engine.client() !== undefined;
      for (const file of pdfs) {
        // A too-large file is refused now, not after the engine has loaded.
        const refusal = sizeRefusal(file);
        if (refusal !== null) {
          reportRpcError(toasts, refusal);
          continue;
        }
        const budget = prefetchBudgetRef.current;
        const prefetch = !ready && budget.current + file.size <= PREFETCH_MAX_BYTES;
        let prefetched: Promise<ArrayBuffer> | undefined;
        if (prefetch) {
          budget.current += file.size;
          prefetched = file.arrayBuffer();
          // A read that fails before its turn is reported when the file's turn comes; until then
          // the rejection must not count as unhandled.
          void prefetched.catch(() => undefined);
        }
        const entry: QueuedOpen = {
          id: nextQueueIdRef.current,
          file,
          listed: !ready,
          prefetched,
        };
        nextQueueIdRef.current += 1;
        queueRef.current = [...queueRef.current, entry];
      }
      showPending();
      void drain();
    },
    [engine, drain, showPending],
  );

  const cancelPending = useCallback(
    (id: number) => {
      const entry = queueRef.current.find((candidate) => candidate.id === id);
      if (entry === undefined) return;
      queueRef.current = queueRef.current.filter((candidate) => candidate !== entry);
      releaseBudget(prefetchBudgetRef.current, entry);
      showPending();
    },
    [showPending],
  );

  const openPicker = useCallback((hintName?: string) => {
    setPickHint(hintName ?? null);
    inputRef.current?.click();
  }, []);

  const showStartPage = useCallback(() => {
    setShowStart(true);
    setRecent(readRecentFiles());
  }, []);

  const selectTab = useCallback(
    (id: number) => {
      commitTabs((state) => activateTab(state, id));
      setShowStart(false);
    },
    [commitTabs],
  );

  const closeTab = useCallback(
    (id: number) => {
      const tab = tabs.tabs.find((candidate) => candidate.id === id);
      commitTabs((state) => closeTabState(state, id));
      // The document view of a closed tab goes with it: no session is kept for it.
      setTabSession(id, null);
      forgetBookmarksTab(id);
      if (tab === undefined) return;
      const client = engine.client();
      if (client === undefined) return;
      client.call('session.close', { handle: tab.handle }).catch((error: unknown) => {
        reportRpcError(toasts, asRpcError(error));
      });
    },
    [tabs, engine, commitTabs],
  );

  const setPages = useCallback(
    (id: number, pages: number) => {
      commitTabs((state) => setPageCount(state, id, pages));
    },
    [commitTabs],
  );

  return {
    tabs,
    recent,
    showStart,
    pickHint,
    pending,
    inputRef,
    openFiles,
    cancelPending,
    openPicker,
    showStartPage,
    selectTab,
    closeTab,
    setPages,
  };
}
