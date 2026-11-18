// The document state the app shell reads (W4.2b): the tabs, the recent files and the start page.
// Opening a file stores it in a tab and records its name. The engine is not started by this
// module yet, so the page says so in a toast instead of opening the document (see the open
// toast below). Everything the user reads comes through t().
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { toasts } from '../feedback/toasts';
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

export function useDocuments(): Documents {
  const [tabs, setTabs] = useState<TabState>(EMPTY_TABS);
  const [recent, setRecent] = useState<RecentFile[]>(() => readRecentFiles());
  const [showStart, setShowStart] = useState(false);
  const [pickHint, setPickHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dirty = hasDirtyTab(tabs);

  // Warn before the page closes while a document has unsaved changes.
  useEffect(() => (dirty ? guardUnload(window) : undefined), [dirty]);

  const openFiles = useCallback((files: readonly File[]) => {
    const pdfs = files.filter(isPdfFile);
    const others = files.filter((file) => !isPdfFile(file));
    if (others.length > 0) {
      toasts.push('error', t('open.notPdf', { name: others[0]?.name ?? '' }));
    }
    if (pdfs.length === 0) return;
    let latest: RecentFile[] | null = null;
    for (const file of pdfs) {
      setTabs((state) => addTab(state, file));
      latest = addRecentFile(file.name);
      // The engine is not started by the app yet, so the document is kept in its tab and the user
      // is told why it is not shown.
      toasts.push('info', t('open.engineNotConnected', { name: file.name }));
    }
    if (latest !== null) setRecent(latest);
    setShowStart(false);
    setPickHint(null);
  }, []);

  const openPicker = useCallback((hintName?: string) => {
    setPickHint(hintName ?? null);
    inputRef.current?.click();
  }, []);

  const showStartPage = useCallback(() => {
    setShowStart(true);
    setRecent(readRecentFiles());
  }, []);

  const selectTab = useCallback((id: number) => {
    setTabs((state) => activateTab(state, id));
    setShowStart(false);
  }, []);

  const closeTab = useCallback((id: number) => {
    setTabs((state) => closeTabState(state, id));
  }, []);

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
