import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { NarrowNotice } from './layout/NarrowNotice';
import { layoutForWidth } from './layout/breakpoints';
import { useViewportWidth } from './layout/useViewportWidth';
import { BrandMark } from './theme/BrandMark';
import { ThemeSwitch } from './theme/ThemeSwitch';
import { type AppMenuPanelItem, AppMenu } from './ribbon/AppMenu';
import { type RibbonPrefs } from './ribbon/form';
import { Ribbon } from './ribbon/Ribbon';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { onPreferencesChanged, readPreferences, writePreferences } from './prefs/store';
import { CombineDialog } from './combine/CombineDialog';
import { PropertiesDialog } from './properties/PropertiesDialog';
import { CommandPalette } from './palette/CommandPalette';
import { ShortcutsDialog } from './palette/ShortcutsDialog';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { neighbourTabId } from './tabs/tabState';
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
import { type ViewCommandId, runViewCommand } from './view/viewCommands';
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
import { closePanel, openPanel, togglePanel, useOpenPanel } from './layout/sidePanels';
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
  ribbonCompact: false,
  ribbonCollapsed: false,
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
  // Bumped by Ctrl+F so the search panel moves focus to its query box (see SearchPanel).
  const [searchFocus, setSearchFocus] = useState(0);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Keyboard Shortcuts (W4.5 S2): from the app menu, the ribbon or Preferences. It opens above
  // Preferences, which keeps its unsaved draft.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // The ribbon's compact and collapse choices (W4.3a S2). The page keeps its own copy, so a toggle
  // works even where the browser refuses to store it; a saved change (from Preferences too) wins.
  const [ribbonPrefs, setRibbonPrefs] = useState<RibbonPrefs>(() => {
    const prefs = readPreferences();
    return { compact: prefs.ribbonCompact, collapsed: prefs.ribbonCollapsed };
  });
  useEffect(
    () =>
      onPreferencesChanged(() => {
        const prefs = readPreferences();
        setRibbonPrefs({ compact: prefs.ribbonCompact, collapsed: prefs.ribbonCollapsed });
      }),
    [],
  );
  function setRibbonChoice(choice: RibbonPrefs): void {
    setRibbonPrefs(choice);
    writePreferences({
      ...readPreferences(),
      ribbonCompact: choice.compact,
      ribbonCollapsed: choice.collapsed,
    });
  }
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
  // Next and Previous Document (W4.3b D6): step through the tabs in order and wrap, as the
  // desktop does. With no tab active, Next starts at the first and Previous at the last.
  const cycleDocument = (step: 1 | -1): void => {
    const id = neighbourTabId(docs.tabs, step);
    if (id !== null) docs.selectTab(id);
  };
  const baseHandlers: CommandHandlers = {
    preferences: () => setPreferencesOpen(true),
    'next-document': () => cycleDocument(1),
    'previous-document': () => cycleDocument(-1),
    'collapse-ribbon': () => setRibbonChoice({ ...ribbonPrefs, collapsed: !ribbonPrefs.collapsed }),
    'compact-ribbon': () => setRibbonChoice({ ...ribbonPrefs, compact: !ribbonPrefs.compact }),
    'keyboard-shortcuts': () => setShortcutsOpen(true),
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
    // Ctrl+F: the search panel, on the left, with focus in its query box (also when it is open).
    find: () => {
      openPanel('search');
      setSearchFocus((count) => count + 1);
    },
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
  // One open panel per side (W4.2a S1): the left rail's panel and the right rail's panel.
  const leftPanelOpen = useOpenPanel('left');
  const rightPanelOpen = useOpenPanel('right');
  // With the left rail hidden (below 768 px) the menu lists the left panels instead (W4.2a S7b).
  const leftRailShown = layoutForWidth(useViewportWidth()).leftRail;
  // The search hits the document view draws, with the tab they belong to (W5.4).
  const [searchMarks, setSearchMarks] = useState<{ tabId: number; marks: SearchMarks } | null>(
    null,
  );
  const documentShown = !showStart && activeId !== null && session !== null && scheduler !== null;
  // The left panels as menu items: they open the same panel the rail button does.
  const menuPanelItems: readonly AppMenuPanelItem[] = [
    {
      id: 'pages',
      label: t('thumbnails.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('pages');
      },
    },
    {
      id: 'bookmarks',
      label: t('bookmarks.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('bookmarks');
      },
    },
    {
      id: 'search',
      label: t('search.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('search');
      },
    },
  ];
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
    ribbonCompact: ribbonPrefs.compact,
    ribbonCollapsed: ribbonPrefs.collapsed,
  };
  // The View zoom and Home navigate commands run on the open document's view (W4.2a S6). The view is
  // read when a command runs, not during render; with no document no handler is given, and the
  // registry's "needs a document" rule applies first.
  const runView = useCallback((id: ViewCommandId) => {
    const view = viewRef.current;
    if (view !== null) runViewCommand(id, view);
  }, []);
  const handlers: CommandHandlers = {
    ...baseHandlers,
    ...(documentShown
      ? {
          // Go to Page (W4.3b) focuses the canvas pill's page field.
          'go-to-page': () => viewRef.current?.focusPageField(),
          'zoom-in': () => runView('zoom-in'),
          'zoom-out': () => runView('zoom-out'),
          'fit-width': () => runView('fit-width'),
          'fit-page': () => runView('fit-page'),
          'actual-size': () => runView('actual-size'),
          'previous-page': () => runView('previous-page'),
          'next-page': () => runView('next-page'),
          back: () => stepBack(-1),
          forward: () => stepBack(1),
        }
      : {}),
  };
  return (
    <AppFrame
      statusBar={
        documentShown ? (
          <DocumentStatusBar
            zoom={viewState.zoom}
            layout={viewState.layout}
            canBack={canGoBack(history)}
            canForward={canGoForward(history)}
            onBack={() => stepBack(-1)}
            onForward={() => stepBack(1)}
            onFocusPageField={() => viewRef.current?.focusPageField()}
          />
        ) : undefined
      }
      railsHidden={showStart}
      onDismissPanel={closePanel}
      leftRail={
        <>
          <RailButton
            panel="pages"
            label={t('thumbnails.title')}
            icon={RAIL_ICONS.pages}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
          />
          <RailButton
            panel="bookmarks"
            label={t('bookmarks.title')}
            icon={RAIL_ICONS.bookmarks}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
          />
          <RailButton
            panel="search"
            label={t('search.title')}
            icon={RAIL_ICONS.search}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
            count={
              searchMarks !== null && searchMarks.tabId === activeId
                ? searchMarks.marks.hits.length
                : 0
            }
          />
        </>
      }
      leftPanel={
        documentShown && leftPanelOpen === 'search' && activeId !== null && session !== null ? (
          <SearchPanel
            key={activeId}
            rpc={session.rpc}
            handle={session.handle}
            onMarks={(marks) => setSearchMarks(marks === null ? null : { tabId: activeId, marks })}
            onGoTo={goTo}
            onClose={() => closePanel('left')}
            focusRequest={searchFocus}
          />
        ) : documentShown &&
          leftPanelOpen === 'bookmarks' &&
          activeId !== null &&
          session !== null ? (
          <BookmarksPanel
            key={`bookmarks-${structureRevision}`}
            rpc={session.rpc}
            handle={session.handle}
            tabId={activeId}
            onSelect={goTo}
            onClose={() => closePanel('left')}
          />
        ) : documentShown && leftPanelOpen === 'pages' && session !== null && scheduler !== null ? (
          <ThumbnailsPanel
            key={`thumbs-${structureRevision}`}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onSelect={goTo}
            onClose={() => closePanel('left')}
          />
        ) : undefined
      }
      rightRail={
        <RailButton
          panel="organizer"
          label={t('organizer.title')}
          icon={RAIL_ICONS.organizer}
          disabled={!documentShown}
          controlsId={documentShown ? 'app-panel-right' : undefined}
        />
      }
      rightPanel={
        documentShown && rightPanelOpen === 'organizer' && session !== null ? (
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
            onClose={() => closePanel('right')}
          />
        ) : undefined
      }
      header={
        <>
          <div className="app-header">
            <div className="app-header-start">
              <AppMenu
                registry={REGISTRY}
                state={state}
                handlers={handlers}
                panelItems={leftRailShown ? undefined : menuPanelItems}
              />
              <BrandMark />
            </div>
            <DocumentTabs state={docs.tabs} onSelect={docs.selectTab} onClose={docs.closeTab} />
            <button
              type="button"
              onClick={() => runCommand(REGISTRY, 'preferences', state, handlers)}
            >
              {t('command.preferences.label')}
            </button>
            <ThemeSwitch />
          </div>
          <NarrowNotice />
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
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        registry={REGISTRY}
        state={state}
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
