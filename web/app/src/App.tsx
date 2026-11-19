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
import { AppMenu } from './ribbon/AppMenu';
import { Ribbon } from './ribbon/Ribbon';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { CombineDialog } from './combine/CombineDialog';
import { PropertiesDialog } from './properties/PropertiesDialog';
import { CommandPalette } from './palette/CommandPalette';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { useTabSession } from './engine/engineConnection';
import { jobWorkerBootOptions } from './engine/bootOptions';
import { startJobWorker } from './engine/start';
import { createJobWorkerPool, type JobWorkerPool } from './engine/jobPool';
import { SanitizeDialog } from './sanitize/SanitizeDialog';
import { FlattenDialog } from './flatten/FlattenDialog';
import { CommentsExportDialog } from './commentsExport/CommentsExportDialog';
import { CommentsImportDialog } from './commentsImport/CommentsImportDialog';
import { SplitDialog } from './split/SplitDialog';
import { ExportDialog } from './export/ExportDialog';
import { CompressDialog } from './compress/CompressDialog';
import { CompareDialog } from './compare/CompareDialog';
import { type DocumentViewHandle, type DocumentViewState, DocumentView } from './view/DocumentView';
import { DocumentStatusBar } from './view/DocumentStatusBar';
import { recordTabJump, stepTabHistory, useNavHistory } from './view/navHistory';
import { canGoBack, canGoForward } from './view/navigation';
import { DEFAULT_ZOOM } from './view/zoom';
import { RenderScheduler } from './view/renderScheduler';
import { BookmarksPanel } from './bookmarks/BookmarksPanel';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';
import { OrganizerPanel } from './organizer/OrganizerPanel';
import { SearchPanel } from './search/SearchPanel';
import type { SearchMarks } from './search/search';
import { RailButton } from './layout/RailButton';
import { RAIL_ICONS } from './layout/railIcons';
import {
  closePanel,
  PANEL_SIDE,
  type PanelKey,
  togglePanel,
  useOpenPanel,
} from './layout/sidePanels';
import { APP_VERSION } from './version';
import { type LaunchInbox, installLaunchInbox } from './pwa/launch';
import './app.css';

// The command state every command reads before the document fields are filled in (see `state`).
const BASE_COMMAND_STATE: CommandState = {
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
  // The job worker pool (W3.1 slice 2). Tests leave it out and get a pool of their own.
  readonly jobs?: JobWorkerPool;
  // The OS launches of PDFs (W4.6 S1). Tests leave it out: nothing is delivered then.
  readonly launches?: LaunchInbox;
}

const NO_LAUNCHES = installLaunchInbox(undefined, {
  failed: () => undefined,
  tooMany: () => undefined,
});

export function App({
  engine,
  startPrintWorker,
  jobs: jobsProp,
  launches = NO_LAUNCHES,
}: AppProps) {
  const ownPool = useMemo(
    () => createJobWorkerPool({ start: () => startJobWorker(jobWorkerBootOptions()) }),
    [],
  );
  const jobs = jobsProp ?? ownPool;
  // StrictMode runs this cleanup once at mount, so the warm-up flag resets with the pool: the next
  // page draw warms the pool again (jobs.warm re-arms a disposed pool).
  const warmed = useRef(false);
  useEffect(
    () => () => {
      warmed.current = false;
      jobs.dispose();
    },
    [jobs],
  );
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [sanitizeOpen, setSanitizeOpen] = useState(false);
  const [flattenOpen, setFlattenOpen] = useState(false);
  const [commentsExportOpen, setCommentsExportOpen] = useState(false);
  const [commentsImportOpen, setCommentsImportOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const docs = useDocuments(engine);
  // Files the OS hands to the app open through the same path as the Open button (W4.6 S1).
  useEffect(() => launches.attach(docs.openFiles), [launches, docs.openFiles]);
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
  const handlers: CommandHandlers = {
    preferences: () => setPreferencesOpen(true),
    print: () => setPrintOpen(true),
    open: () => docs.openPicker(),
    'open-recent': () => docs.showStartPage(),
    'split-document': () => setSplitOpen(true),
    'export-pdf': () => setExportOpen(true),
    'reduce-file-size': () => setCompressOpen(true),
    'combine-files-into-pdf': () => setCombineOpen(true),
    'document-properties': () => setPropertiesOpen(true),
    'sanitize-document': () => setSanitizeOpen(true),
    'compare-files': () => setCompareOpen(true),
    'flatten-all-comments': () => setFlattenOpen(true),
    'export-comments': () => setCommentsExportOpen(true),
    'import-comments': () => setCommentsImportOpen(true),
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
  // The job worker is warmed once per page load, after the first page of the first document is
  // drawn (W1.1). Later documents do nothing; the dispose cleanup above clears the flag.
  useEffect(() => {
    let stale = false;
    void scheduler?.firstPage.then(() => {
      if (stale || warmed.current) return;
      warmed.current = true;
      jobs.warm();
    });
    return () => {
      stale = true;
    };
  }, [scheduler, jobs]);
  const viewRef = useRef<DocumentViewHandle>(null);
  // Bumped after the page organizer changes the pages: the view and the thumbnails then mount again
  // and read the page list from the engine.
  const [structureRevision, setStructureRevision] = useState(0);
  // One panel shows at a time (W4.2a S1): the left side's panel, or else the right side's. The left
  // panels get their own slot in S2.
  const leftPanelOpen = useOpenPanel('left');
  const rightPanelOpen = useOpenPanel('right');
  const shownPanel = leftPanelOpen ?? rightPanelOpen;
  // Until S2 docks the left panels, a panel on either side closes the other side's, so only one
  // panel shows at a time, as before the side-panel store.
  // TODO(W4.2a S2): remove the one-panel bridge once panels sit on their own side.
  const selectPanel = (key: PanelKey) => {
    closePanel(PANEL_SIDE[key] === 'left' ? 'right' : 'left');
    togglePanel(key);
  };
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
    layout: 'continuous',
    labels: [],
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
  // The commands read the document as it is shown now, so the ribbon enables the document commands
  // only while one is open.
  const state: CommandState = {
    ...BASE_COMMAND_STATE,
    hasDocument: documentShown,
    hasRecentFiles: docs.recent.length > 0,
  };
  return (
    <AppFrame
      statusBar={
        documentShown ? (
          <DocumentStatusBar
            page={viewState.page}
            total={activeTab?.pages ?? 0}
            zoom={viewState.zoom}
            layout={viewState.layout}
            labels={viewState.labels}
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
          <RailButton
            panel="pages"
            label={t('thumbnails.title')}
            icon={RAIL_ICONS.pages}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-right' : undefined}
            onToggle={selectPanel}
          />
          <RailButton
            panel="bookmarks"
            label={t('bookmarks.title')}
            icon={RAIL_ICONS.bookmarks}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-right' : undefined}
            onToggle={selectPanel}
          />
          <RailButton
            panel="organizer"
            label={t('organizer.title')}
            icon={RAIL_ICONS.organizer}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-right' : undefined}
            onToggle={selectPanel}
          />
          <RailButton
            panel="search"
            label={t('search.title')}
            icon={RAIL_ICONS.search}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-right' : undefined}
            onToggle={selectPanel}
          />
        </>
      }
      rightPanel={
        documentShown && shownPanel === 'search' && activeId !== null && session !== null ? (
          <SearchPanel
            key={activeId}
            rpc={session.rpc}
            handle={session.handle}
            onMarks={(marks) => setSearchMarks(marks === null ? null : { tabId: activeId, marks })}
            onGoTo={goTo}
            onClose={() => closePanel(PANEL_SIDE.search)}
          />
        ) : documentShown && shownPanel === 'bookmarks' && activeId !== null && session !== null ? (
          <BookmarksPanel
            key={`bookmarks-${structureRevision}`}
            rpc={session.rpc}
            handle={session.handle}
            tabId={activeId}
            onSelect={goTo}
            onClose={() => closePanel(PANEL_SIDE.bookmarks)}
          />
        ) : documentShown && shownPanel === 'pages' && session !== null && scheduler !== null ? (
          <ThumbnailsPanel
            key={`thumbs-${structureRevision}`}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onSelect={goTo}
            onClose={() => closePanel(PANEL_SIDE.pages)}
          />
        ) : documentShown && shownPanel === 'organizer' && session !== null ? (
          <OrganizerPanel
            rpc={session.rpc}
            handle={session.handle}
            documentName={activeTab?.name ?? ''}
            startWorker={jobs.acquire}
            onChanged={(pageCount) => {
              // The search marks name pages by index, which a change may have moved.
              setSearchMarks(null);
              setStructureRevision((value) => value + 1);
              // The dialogs and the status bar read the tab's page count, so it follows the change.
              if (activeId !== null) docs.setPages(activeId, pageCount);
            }}
            onClose={() => closePanel(PANEL_SIDE.organizer)}
          />
        ) : undefined
      }
      header={
        <>
          <div className="app-header">
            <div className="app-header-start">
              <AppMenu registry={REGISTRY} state={state} handlers={handlers} />
              <BrandMark />
            </div>
            <button
              type="button"
              onClick={() => runCommand(REGISTRY, 'preferences', state, handlers)}
            >
              {t('command.preferences.label')}
            </button>
            <ThemeSwitch />
          </div>
          <Ribbon registry={REGISTRY} state={state} handlers={handlers} />
        </>
      }
    >
      <PreferencesDialog
        isOpen={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        // Any open tab counts, including one still loading or behind the start page (Open Recent):
        // clearing reloads the page, which would lose its unsaved edits. A file still queued or
        // opening (docs.pending) counts too: it can finish while the confirmation is showing.
        hasDocuments={docs.tabs.tabs.length > 0 || docs.pending.length > 0}
      />
      {documentShown && session !== null && activeTab !== undefined && rpc !== undefined ? (
        <SplitDialog
          isOpen={splitOpen}
          onClose={() => setSplitOpen(false)}
          engine={rpc}
          handle={session.handle}
          pageCount={activeTab.pages}
          startWorker={jobs.acquire}
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
          startWorker={jobs.acquire}
        />
      ) : null}
      {documentShown && session !== null && rpc !== undefined ? (
        <CompressDialog
          isOpen={compressOpen}
          onClose={() => setCompressOpen(false)}
          engine={rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined && rpc !== undefined ? (
        <CompareDialog
          isOpen={compareOpen}
          onClose={() => setCompareOpen(false)}
          engine={rpc}
          handle={session.handle}
          currentName={activeTab.name}
          startWorker={jobs.acquire}
          onGoToPage={goTo}
        />
      ) : null}
      {documentShown && session !== null ? (
        <SanitizeDialog
          isOpen={sanitizeOpen}
          onClose={() => setSanitizeOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
          onChanged={(changed) => scheduler?.noteRevisions(changed?.revisions ?? {})}
        />
      ) : null}
      {documentShown && session !== null ? (
        <FlattenDialog
          isOpen={flattenOpen}
          onClose={() => setFlattenOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
          onChanged={(changed) => scheduler?.noteRevisions(changed?.revisions ?? {})}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <CommentsExportDialog
          isOpen={commentsExportOpen}
          onClose={() => setCommentsExportOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          name={activeTab.name}
          startWorker={jobs.acquire}
        />
      ) : null}
      {documentShown && session !== null ? (
        <CommentsImportDialog
          isOpen={commentsImportOpen}
          onClose={() => setCommentsImportOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          onChanged={(changed) => scheduler?.noteRevisions(changed?.revisions ?? {})}
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
      <CombineDialog
        isOpen={combineOpen}
        onClose={() => setCombineOpen(false)}
        startWorker={jobs.acquire}
      />
      {documentShown && session !== null ? (
        <PropertiesDialog
          isOpen={propertiesOpen}
          onClose={() => setPropertiesOpen(false)}
          rpc={session.rpc}
          handle={session.handle}
        />
      ) : null}
      <CommandPalette registry={REGISTRY} state={state} handlers={handlers} />
      <OpenInput inputRef={docs.inputRef} onFiles={docs.openFiles} />
      <DocumentTabs state={docs.tabs} onSelect={docs.selectTab} onClose={docs.closeTab} />
      <div className="app-main">
        <UpdatePrompt />
        <PasswordPrompt />
        <ToastRegion />
        <NotRespondingHost />
        <JobProgressHost />
        {showStart ? (
          // The load stages sit in the start page, which stays usable while the engine loads (W3.1).
          <StartPage
            recent={docs.recent}
            pickHint={docs.pickHint}
            loading={<EngineLoadingScreen store={engine.store} />}
            pending={docs.pending}
            onCancelPending={docs.cancelPending}
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
            startWorker={jobs.acquire}
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
