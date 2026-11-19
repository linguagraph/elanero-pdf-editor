import { useEffect, useMemo, useRef, useState } from 'react';
import { About } from './about';
import { REGISTRY } from './commands/catalog';
import { type CommandHandlers, runCommand } from './commands/run';
import { type CommandState } from './commands/registry';
import { t } from './i18n/t';
import { EngineLoadingScreen } from './feedback/LoadingScreen';
import type { EngineConnection } from './engine/engineConnection';
import { PasswordPrompt } from './documents/PasswordPrompt';
import { ToastRegion } from './feedback/ToastRegion';
import { NotRespondingHost } from './feedback/NotRespondingHost';
import { JobProgressHost } from './feedback/JobProgressHost';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import { AppFrame } from './layout/AppFrame';
import { BrandMark } from './theme/BrandMark';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { CommandPalette } from './palette/CommandPalette';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { useTabSession } from './engine/engineConnection';
import { type DocumentViewHandle, type DocumentViewState, DocumentView } from './view/DocumentView';
import { DocumentStatusBar } from './view/DocumentStatusBar';
import { recordTabJump, stepTabHistory, useNavHistory } from './view/navHistory';
import { canGoBack, canGoForward } from './view/navigation';
import { DEFAULT_ZOOM } from './view/zoom';
import { RenderScheduler } from './view/renderScheduler';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';
import { ThumbnailsRailButton } from './thumbnails/ThumbnailsRailButton';
import { setThumbnailsOpen, useThumbnailsOpen } from './thumbnails/openState';
import { SearchPanel } from './search/SearchPanel';
import { SearchRailButton } from './search/SearchRailButton';
import { setSearchOpen, useSearchOpen } from './search/openState';
import type { SearchMarks } from './search/search';
import { APP_VERSION } from './version';
import './app.css';

// No document is open yet, so the state every command reads is empty.
const NO_DOCUMENT_STATE: CommandState = {
  hasDocument: false,
  hasRecentFiles: false,
  canUndo: false,
  canRedo: false,
  capabilities: new Set(),
};

// Placeholder shell: the region frame is in place (W4.2a); the ribbon and the features come later.
// The start page and the document tabs (W4.2b) are in place.
export interface AppProps {
  // The engine link (W3.1). App starts it once, after the first paint, and stops it on unmount.
  readonly engine: EngineConnection;
}

export function App({ engine }: AppProps) {
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const docs = useDocuments(engine);
  useEffect(() => {
    // Two frames: the start-up screen is painted before the engine begins to load.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        engine.start();
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      engine.dispose();
    };
  }, [engine]);
  const state: CommandState = { ...NO_DOCUMENT_STATE, hasRecentFiles: docs.recent.length > 0 };
  const handlers: CommandHandlers = {
    preferences: () => setPreferencesOpen(true),
    open: () => docs.openPicker(),
    'open-recent': () => docs.showStartPage(),
  };
  const showStart = docs.tabs.tabs.length === 0 || docs.showStart;
  const activeId = docs.tabs.activeId;
  const session = useTabSession(activeId);
  // One scheduler per open session: the document view and the thumbnails panel share its cache and
  // its render limit (W5.2).
  const scheduler = useMemo(
    () => (session === null ? null : new RenderScheduler(session.rpc, session.handle)),
    [session],
  );
  const viewRef = useRef<DocumentViewHandle>(null);
  const thumbnailsOpen = useThumbnailsOpen(activeId);
  const searchOpen = useSearchOpen(activeId);
  // The search hits the document view draws, with the tab they belong to (W5.4).
  const [searchMarks, setSearchMarks] = useState<{ tabId: number; marks: SearchMarks } | null>(
    null,
  );
  const documentShown = !showStart && activeId !== null && session !== null && scheduler !== null;
  const activeTab = docs.tabs.tabs.find((tab) => tab.id === activeId);
  // The page and zoom the document view reports, for the status bar under the document.
  const [viewState, setViewState] = useState<DocumentViewState>({
    page: 1,
    zoom: DEFAULT_ZOOM,
  });
  // A jump or a thumbnail click that moves the view by more than a page is recorded per tab; Back
  // and Forward move through it (W5.3).
  const history = useNavHistory(activeId);
  const goTo = (index: number) => {
    if (activeId !== null) recordTabJump(activeId, viewState.page - 1, index);
    viewRef.current?.scrollToPage(index);
  };
  const stepBack = (direction: -1 | 1) => {
    if (activeId === null) return;
    const page = stepTabHistory(activeId, direction);
    if (page !== null) viewRef.current?.scrollToPage(page);
  };
  return (
    <AppFrame
      statusBar={
        documentShown ? (
          <DocumentStatusBar
            page={viewState.page}
            total={activeTab?.pages ?? 0}
            zoom={viewState.zoom}
            canBack={canGoBack(history)}
            canForward={canGoForward(history)}
            onGoTo={goTo}
            onBack={() => stepBack(-1)}
            onForward={() => stepBack(1)}
          />
        ) : undefined
      }
      rightRail={
        <>
          <ThumbnailsRailButton tabId={activeId} disabled={!documentShown} />
          <SearchRailButton tabId={activeId} disabled={!documentShown} />
        </>
      }
      rightPanel={
        documentShown && searchOpen && activeId !== null && session !== null ? (
          <SearchPanel
            key={activeId}
            rpc={session.rpc}
            handle={session.handle}
            onMarks={(marks) => setSearchMarks(marks === null ? null : { tabId: activeId, marks })}
            onGoTo={goTo}
            onClose={() => setSearchOpen(activeId, false)}
          />
        ) : documentShown && thumbnailsOpen && session !== null && scheduler !== null ? (
          <ThumbnailsPanel
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onSelect={goTo}
            onClose={() => {
              if (activeId !== null) setThumbnailsOpen(activeId, false);
            }}
          />
        ) : undefined
      }
      header={
        <div className="app-header">
          <BrandMark />
          <button
            type="button"
            onClick={() => runCommand(REGISTRY, 'preferences', state, handlers)}
          >
            {t('command.preferences.label')}
          </button>
          <ThemeSwitch />
        </div>
      }
    >
      <PreferencesDialog isOpen={preferencesOpen} onClose={() => setPreferencesOpen(false)} />
      <CommandPalette registry={REGISTRY} state={state} handlers={handlers} />
      <OpenInput inputRef={docs.inputRef} onFiles={docs.openFiles} />
      <DocumentTabs state={docs.tabs} onSelect={docs.selectTab} onClose={docs.closeTab} />
      <div className="app-main">
        <UpdatePrompt />
        <EngineLoadingScreen store={engine.store} />
        <PasswordPrompt />
        <ToastRegion />
        <NotRespondingHost />
        <JobProgressHost />
        {showStart ? (
          <StartPage
            recent={docs.recent}
            pickHint={docs.pickHint}
            onOpen={() => docs.openPicker()}
            onRecent={(name) => docs.openPicker(name)}
            onFiles={docs.openFiles}
          />
        ) : null}
        {documentShown && session !== null && scheduler !== null ? (
          <DocumentView
            key={activeId}
            ref={viewRef}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onViewChange={setViewState}
            searchMarks={
              searchMarks !== null && searchMarks.tabId === activeId ? searchMarks.marks : undefined
            }
          />
        ) : null}
        {documentShown ? null : (
          <>
            <h1>{t('app.name')}</h1>
            <p>{t('app.version', { version: APP_VERSION })}</p>
            <About />
          </>
        )}
      </div>
    </AppFrame>
  );
}
