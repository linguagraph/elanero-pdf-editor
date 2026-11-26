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
import { markLoadStage } from '../perf/marks';
import {
  addRecentFile,
  cleanRecentName,
  readRecentFiles,
  type RecentFile,
} from '../recent/recentFiles';
import {
  filePickerOf,
  type HandleStore,
  loadRecentHandles,
  reopenFromHandle,
  saveRecentHandle,
  type StoredFileHandle,
} from '../recent/recentHandles';
import {
  createRecentThumbs,
  keepRecentThumb,
  type RecentThumbs,
  whenIdle,
} from '../recent/recentThumbs';
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
  renameTab as renameTabState,
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

// Whether the engine can change the document's content (its content_edit capability, W6.7a). A
// failed read counts as no: the Edit tool's commands then say so, and the document still opens.
async function contentEditOf(client: EngineClient, handle: string): Promise<boolean> {
  try {
    const capabilities = await client.call('session.capabilities', { handle });
    return capabilities.engine.content_edit === true;
  } catch {
    return false;
  }
}

export interface Documents {
  readonly tabs: TabState;
  readonly recent: readonly RecentFile[];
  // The first-page previews of the recent files, as object URLs by name (issue 757). Kept on this
  // device only; a name without one shows the file icon.
  readonly previews: ReadonlyMap<string, string>;
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
  // Opens a recent file from its saved handle with no dialog (issue 756); the picker when there is none.
  openRecent(name: string): void;
  // Keeps the handles of a PDF dropped on the start page (issue 756).
  rememberDropped(data: DataTransfer): void;
  showStartPage(): void;
  selectTab(id: number): void;
  closeTab(id: number): void;
  // Keeps a tab's page count in step with the engine after an organizer change.
  setPages(id: number, pages: number): void;
  // Gives a tab the name it was saved as, and adds the name to the recent list (W4.9).
  renameTab(id: number, name: string): void;
}

// The File System Access type a picked PDF is offered as. The picker shows PDFs only.
const PDF_PICKER_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];

// The shape of a dropped item that may carry a file handle (Chromium). Narrow on purpose: the
// DOM library's typings do not always include the method.
interface DropItem {
  readonly kind: string;
  getAsFileSystemHandle?(): Promise<unknown>;
}

function isFileHandle(value: unknown): value is StoredFileHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'file' &&
    typeof (value as { getFile?: unknown }).getFile === 'function' &&
    typeof (value as { requestPermission?: unknown }).requestPermission === 'function'
  );
}

export function useDocuments(
  engine: EngineConnection,
  handleStore?: HandleStore,
  previewStore?: RecentThumbs,
): Documents {
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
  // The saved handles by name, held in memory so a recent row's click needs no await before its
  // permission request (the request must come from the click's own gesture).
  const handlesRef = useRef(new Map<string, StoredFileHandle>());
  // The first-page previews (issue 757). Their object URLs are freed when a newer set replaces them.
  const [thumbs] = useState(() => previewStore ?? createRecentThumbs());
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const previewUrlsRef = useRef(new Map<string, string>());
  // The number of the latest load. A load that finishes after a newer one started (or after unmount)
  // is stale: its URLs are freed at once and it changes nothing, so an older list never overwrites a
  // newer one.
  const previewRequestRef = useRef(0);
  const loadPreviews = useCallback(
    (names: readonly string[]) => {
      const request = ++previewRequestRef.current;
      void thumbs.load(names).then((blobs) => {
        const next = new Map<string, string>();
        for (const [name, blob] of blobs) next.set(name, URL.createObjectURL(blob));
        if (request !== previewRequestRef.current) {
          for (const url of next.values()) URL.revokeObjectURL(url);
          return;
        }
        for (const url of previewUrlsRef.current.values()) URL.revokeObjectURL(url);
        previewUrlsRef.current = next;
        setPreviews(next);
      });
    },
    [thumbs],
  );
  // The start page shows with no tab open too (after the last tab closes), so the previews load
  // whenever it is on screen and the list changes.
  const startShown = showStart || tabs.tabs.length === 0;
  useEffect(() => {
    if (startShown) loadPreviews(recent.map((entry) => entry.name));
  }, [startShown, recent, loadPreviews]);
  useEffect(
    () => () => {
      // A load still running is stale now: it frees its own URLs when it lands.
      previewRequestRef.current += 1;
      for (const url of previewUrlsRef.current.values()) URL.revokeObjectURL(url);
      previewUrlsRef.current = new Map();
    },
    [],
  );
  const dirty = hasDirtyTab(tabs);

  // Loads the saved handles now and each time the start page shows. A handle saved in this visit
  // is already in the map and is not replaced by the load.
  const refreshHandles = useCallback(() => {
    void loadRecentHandles(handleStore).then((loaded) => {
      for (const [name, handle] of loaded) {
        if (!handlesRef.current.has(name)) handlesRef.current.set(name, handle);
      }
    });
  }, [handleStore]);
  useEffect(() => {
    refreshHandles();
  }, [refreshHandles]);

  // Keeps a handle for a name in memory and in the store. A failed save is silent: the file still
  // opens, and the row simply uses the picker next time.
  const remember = useCallback(
    (name: string, handle: StoredFileHandle) => {
      const key = cleanRecentName(name);
      if (key === null) return;
      handlesRef.current.set(key, handle);
      void saveRecentHandle(handleStore, key, handle);
    },
    [handleStore],
  );
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
      markLoadStage('open');
      if (warning !== null) toasts.push('info', t('open.largeFile', { name: file.name }));
      // The tab id is the one addTab gives the new tab. Its session lets the document view mount.
      const id = tabsRef.current.nextId;
      const { encrypted, has_signatures: signed } = outcome.result.info;
      const contentEdit = await contentEditOf(client, handle);
      commitTabs((state) =>
        addTab(state, { name: file.name, handle, pages, encrypted, signed, contentEdit }),
      );
      setTabSession(id, { rpc: client, handle });
      void memoryWarner.check(client, 'open');
      const next = addRecentFile(file.name);
      setRecent(next);
      void thumbs.prune(next.map((entry) => entry.name));
      // The preview is drawn once the browser is idle, so the first page is not delayed.
      whenIdle(() => {
        void keepRecentThumb(thumbs, client, handle, file.name, encrypted, next);
      });
      setShowStart(false);
      setPickHint(null);
    },
    [commitTabs, thumbs],
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

  // Chromium's File System Access picker when there is one, so the chosen handles can be kept; the
  // hidden file input elsewhere, as before. The picker is called straight from the click.
  const openPicker = useCallback(
    (hintName?: string) => {
      setPickHint(hintName ?? null);
      const picker = filePickerOf(window);
      if (picker === undefined) {
        inputRef.current?.click();
        return;
      }
      const startIn = hintName === undefined ? undefined : handlesRef.current.get(hintName);
      void picker.call(window, { multiple: true, types: PDF_PICKER_TYPES, startIn }).then(
        async (handles) => {
          const files: File[] = [];
          for (const handle of handles) {
            try {
              const file = await handle.getFile();
              remember(file.name, handle);
              files.push(file);
            } catch {
              // A file the browser cannot read now is skipped; the others still open.
            }
          }
          if (files.length > 0) openFiles(files);
        },
        (error: unknown) => {
          // Cancelling the picker is not a failure. SecurityError means the user's gesture expired
          // (a permission prompt ran first): the input cannot be clicked either, so the hint stays.
          // Any other error falls back to the input.
          const name = (error as { name?: unknown } | null)?.name;
          if (name === 'AbortError' || name === 'SecurityError') return;
          inputRef.current?.click();
        },
      );
    },
    [openFiles, remember],
  );

  // A recent row: reopen from its saved handle with no dialog. Without a handle, or when the
  // permission is refused or the file cannot be read, the picker opens with the hint.
  const openRecent = useCallback(
    (name: string) => {
      const handle = handlesRef.current.get(name);
      // Without a handle the picker opens at once, as before this change.
      if (handle === undefined) {
        openPicker(name);
        return;
      }
      // No await before reopenFromHandle: it asks for permission from the click's gesture.
      void reopenFromHandle(handle).then((file) => {
        if (file === undefined) {
          openPicker(name);
          return;
        }
        openFiles([file]);
      });
    },
    [openFiles, openPicker],
  );

  // The drop's items are read synchronously, as the browser requires during the drop event.
  const rememberDropped = useCallback(
    (data: DataTransfer) => {
      const items = data.items as unknown as DropItem[] | undefined;
      for (const item of Array.from(items ?? [])) {
        if (item.kind !== 'file' || typeof item.getAsFileSystemHandle !== 'function') continue;
        void item.getAsFileSystemHandle().then(
          (handle) => {
            if (isFileHandle(handle)) remember(handle.name, handle);
          },
          () => undefined,
        );
      }
    },
    [remember],
  );

  const showStartPage = useCallback(() => {
    setShowStart(true);
    setRecent(readRecentFiles());
    refreshHandles();
  }, [refreshHandles]);

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

  // A Save As gave the document a new name (W4.9): the tab takes it and the recent list gets it.
  const renameTab = useCallback(
    (id: number, name: string) => {
      commitTabs((state) => renameTabState(state, id, name));
      const next = addRecentFile(name);
      setRecent(next);
      void thumbs.prune(next.map((entry) => entry.name));
    },
    [commitTabs, thumbs],
  );

  return {
    tabs,
    recent,
    previews,
    showStart,
    pickHint,
    pending,
    inputRef,
    openFiles,
    cancelPending,
    openPicker,
    openRecent,
    rememberDropped,
    showStartPage,
    selectTab,
    closeTab,
    setPages,
    renameTab,
  };
}
