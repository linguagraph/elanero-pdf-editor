import { useEffect, useMemo, useRef, useState } from 'react';
import { About } from './about';
import { REGISTRY } from './commands/catalog';
import { type CommandHandlers, runCommand } from './commands/run';
import { type CommandState } from './commands/registry';
import { t } from './i18n/t';
import { EngineLoadingScreen } from './feedback/LoadingScreen';
import type { EngineConnection } from './engine/engineConnection';
import type { WorkerClient } from './engine/start';
import { PrintDialog } from './print/PrintDialog';
import { PasswordPrompt } from './documents/PasswordPrompt';
import { ToastRegion } from './feedback/ToastRegion';
import { NotRespondingHost } from './feedback/NotRespondingHost';
import { JobProgressHost } from './feedback/JobProgressHost';
import { UpdatePrompt } from './pwa/UpdatePrompt';
import { AppFrame } from './layout/AppFrame';
import { BrandMark } from './theme/BrandMark';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { CombineDialog } from './combine/CombineDialog';
import { CommandPalette } from './palette/CommandPalette';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { useTabSession } from './engine/engineConnection';
import { jobWorkerBootOptions } from './engine/bootOptions';
import { startJobWorker } from './engine/start';
import { SplitDialog } from './split/SplitDialog';
import { ExportDialog } from './export/ExportDialog';
import { type DocumentViewHandle, type DocumentViewState, DocumentView } from './view/DocumentView';
import { DocumentStatusBar } from './view/DocumentStatusBar';
import { recordTabJump, stepTabHistory, useNavHistory } from './view/navHistory';
import { canGoBack, canGoForward } from './view/navigation';
import { DEFAULT_ZOOM } from './view/zoom';
import { RenderScheduler } from './view/renderScheduler';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';
import { ThumbnailsRailButton } from './thumbnails/ThumbnailsRailButton';
import { setThumbnailsOpen, useThumbnailsOpen } from './thumbnails/openState';
import { OrganizerPanel } from './organizer/OrganizerPanel';
import { OrganizerRailButton } from './organizer/OrganizerRailButton';
import { setOrganizerOpen, useOrganizerOpen } from './organizer/openState';
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
  // Starts the job worker for a print (W6.5). Tests leave it out; printing then reports nothing.
  readonly startPrintWorker?: () => WorkerClient;
}

export function App({ engine, startPrintWorker }: AppProps) {
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
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
    print: () => setPrintOpen(true),
    open: () => docs.openPicker(),
    'open-recent': () => docs.showStartPage(),
    'split-document': () => setSplitOpen(true),
    'export-pdf': () => setExportOpen(true),
    'combine-files-into-pdf': () => setCombineOpen(true),
  };
  const showStart = docs.tabs.tabs.length === 0 || docs.showStart;
  const activeId = docs.tabs.activeId;
  const session = useTabSession(activeId);
  const rpc = engine.client();
  // One scheduler per open session: the document view and the thumbnails panel share its cache and
  // its render limit (W5.2).
  const scheduler = useMemo(
    () => (session === null ? null : new RenderScheduler(session.rpc, session.handle)),
    [session],
  );
  const viewRef = useRef<DocumentViewHandle>(null);
  const thumbnailsOpen = useThumbnailsOpen(activeId);
  const organizerOpen = useOrganizerOpen(activeId);
  // Bumped after the page organizer changes the pages: the view and the thumbnails then mount again
  // and read the page list from the engine.
  const [structureRevision, setStructureRevision] = useState(0);
  const searchOpen = useSearchOpen(activeId);
  // One right panel shows at a time: opening the thumbnails or the search closes the page organizer.
  useEffect(() => {
    if (activeId !== null && (thumbnailsOpen || searchOpen)) setOrganizerOpen(activeId, false);
  }, [activeId, thumbnailsOpen, searchOpen]);
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
          <OrganizerRailButton tabId={activeId} disabled={!documentShown} />
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
            key={`thumbs-${structureRevision}`}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onSelect={goTo}
            onClose={() => {
              if (activeId !== null) setThumbnailsOpen(activeId, false);
            }}
          />
        ) : documentShown && organizerOpen && session !== null ? (
          <OrganizerPanel
            rpc={session.rpc}
            handle={session.handle}
            onChanged={() => {
              // The search marks name pages by index, which a change may have moved.
              setSearchMarks(null);
              setStructureRevision((value) => value + 1);
            }}
            onClose={() => {
              if (activeId !== null) setOrganizerOpen(activeId, false);
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
      {documentShown && session !== null && activeTab !== undefined && rpc !== undefined ? (
        <SplitDialog
          isOpen={splitOpen}
          onClose={() => setSplitOpen(false)}
          engine={rpc}
          handle={session.handle}
          pageCount={activeTab.pages}
          startWorker={() => startJobWorker(jobWorkerBootOptions())}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined && rpc !== undefined ? (
        <ExportDialog
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          engine={rpc}
          handle={session.handle}
          pageCount={activeTab.pages}
          currentPage={viewState.page}
          startWorker={() => startJobWorker(jobWorkerBootOptions())}
        />
      ) : null}
      <PrintDialog
        isOpen={printOpen}
        onClose={() => setPrintOpen(false)}
        session={session}
        pageCount={activeTab?.pages ?? 0}
        currentPage={viewState.page}
        startWorker={startPrintWorker}
      />
      <CombineDialog isOpen={combineOpen} onClose={() => setCombineOpen(false)} />
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
            key={`${activeId}-${structureRevision}`}
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
