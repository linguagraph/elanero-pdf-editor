// The document state the app shell reads (W4.2b, W3.1): the tabs, the recent files and the start
// page. A chosen PDF is opened through the engine's session.open; its tab is added only when the
// engine has opened it. Closing a tab calls session.close. Everything the user reads comes
// through t().
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type EngineConnection, setTabSession } from '../engine/engineConnection';
import { reportRpcError, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { addRecentFile, readRecentFiles, type RecentFile } from '../recent/recentFiles';
import {
  activateTab,
  addTab,
  closeTab as closeTabState,
  EMPTY_TABS,
  hasDirtyTab,
  type TabState,
} from '../tabs/tabState';
import { asRpcError, openFile } from './openFile';
import { passwordPrompt } from './passwordRequest';
import { guardUnload } from './unloadGuard';

// A file counts as a PDF by its type, or by its name when the browser gives no type.
export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export interface Documents {
  readonly tabs: TabState;
  readonly recent: readonly RecentFile[];
  // True when the start page is shown next to the tabs (Open Recent asks for it).
  readonly showStart: boolean;
  // The name of a recent file the user picked, so the start page can say which one to pick again.
  readonly pickHint: string | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  openFiles(files: readonly File[]): void;
  openPicker(hintName?: string): void;
  showStartPage(): void;
  selectTab(id: number): void;
  closeTab(id: number): void;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = hasDirtyTab(tabs);

  // Warn before the page closes while a document has unsaved changes.
  useEffect(() => (dirty ? guardUnload(window) : undefined), [dirty]);

  // The files are opened one after another: each may ask for a password, and the dialog shows one
  // request at a time.
  const openAll = useCallback(
    async (pdfs: readonly File[]) => {
      const client = engine.client();
      if (client === undefined) {
        toasts.push('info', t('open.engineNotReady'));
        return;
      }
      for (const file of pdfs) {
        const outcome = await openFile(client, file, (name) => passwordPrompt.ask(name));
        if (outcome.status === 'cancelled') continue;
        if (outcome.status === 'failed') {
          reportRpcError(toasts, outcome.error);
          continue;
        }
        const { handle, pages, warning } = outcome.result;
        if (warning !== null) toasts.push('info', t('open.largeFile', { name: file.name }));
        // The tab id is the one addTab gives the new tab. Its session lets the document view mount.
        const id = tabsRef.current.nextId;
        commitTabs((state) => addTab(state, { name: file.name, handle, pages }));
        setTabSession(id, { rpc: client, handle });
        setRecent(addRecentFile(file.name));
        setShowStart(false);
        setPickHint(null);
      }
    },
    [engine, commitTabs],
  );

  const openFiles = useCallback(
    (files: readonly File[]) => {
      const pdfs = files.filter(isPdfFile);
      const others = files.filter((file) => !isPdfFile(file));
      if (others.length > 0) {
        toasts.push('error', t('open.notPdf', { name: others[0]?.name ?? '' }));
      }
      if (pdfs.length === 0) return;
      void openAll(pdfs);
    },
    [openAll],
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
      if (tab === undefined) return;
      const client = engine.client();
      if (client === undefined) return;
      client.call('session.close', { handle: tab.handle }).catch((error: unknown) => {
        reportRpcError(toasts, asRpcError(error));
      });
    },
    [tabs, engine, commitTabs],
  );

  return {
    tabs,
    recent,
    showStart,
    pickHint,
    inputRef,
    openFiles,
    openPicker,
    showStartPage,
    selectTab,
    closeTab,
  };
}
