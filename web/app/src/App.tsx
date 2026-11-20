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
import { QuickAccess } from './ribbon/QuickAccess';
import { openGuide, WEB_VERSION_PAGE } from './help/guide';
import { Overlay } from './layout/Overlay';
import { type RibbonPrefs } from './ribbon/form';
import { Ribbon } from './ribbon/Ribbon';
import { PreferencesDialog } from './prefs/PreferencesDialog';
import { onPreferencesChanged, readPreferences, writePreferences } from './prefs/store';
import { CombineDialog } from './combine/CombineDialog';
import { PropertiesDialog } from './properties/PropertiesDialog';
import { CommandPalette } from './palette/CommandPalette';
import { openCommandPalette } from './palette/openCommandPalette';
import { ShortcutsDialog } from './palette/ShortcutsDialog';
import { useDocuments } from './documents/useDocuments';
import { OpenInput } from './documents/OpenInput';
import { StartPage } from './start/StartPage';
import { DocumentTabs } from './tabs/DocumentTabs';
import { type DocumentTab, neighbourTabId } from './tabs/tabState';
import { useTabSession } from './engine/engineConnection';
import { jobWorkerBootOptions } from './engine/bootOptions';
import { startJobWorker } from './engine/start';
import { createJobWorkerPool, type JobWorkerPool } from './engine/jobPool';
import { SanitizeDialog } from './sanitize/SanitizeDialog';
import { FlattenDialog } from './flatten/FlattenDialog';
import { CropDialog } from './crop/CropDialog';
import { useCropSession } from './crop/useCropSession';
import type { ChangedDto, HistoryResult } from './rpc/generated';
import { type HistoryDirection, runHistoryStep } from './history/runHistory';
import { CommentsExportDialog } from './commentsExport/CommentsExportDialog';
import { CommentsImportDialog } from './commentsImport/CommentsImportDialog';
import { SplitDialog } from './split/SplitDialog';
import { ExportDialog } from './export/ExportDialog';
import { ExtractImagesDialog } from './extract/ExtractImagesDialog';
import { CompressDialog } from './compress/CompressDialog';
import { CompareDialog } from './compare/CompareDialog';
import { ApplyConfirm } from './redaction/ApplyConfirm';
import { RedactionController } from './redaction/controller';
import { MarkPagesDialog } from './redaction/MarkPagesDialog';
import { markSelectedText } from './redaction/markText';
import { RedactionsPanel } from './redaction/RedactionsPanel';
import { RedactionPropertiesDialog } from './redaction/RedactionPropertiesDialog';
import { useRedactionState } from './redaction/useRedaction';
import { type DocumentViewHandle, type DocumentViewState, DocumentView } from './view/DocumentView';
import { DocumentStatusBar } from './view/DocumentStatusBar';
import { type ViewCommandId, runViewCommand } from './view/viewCommands';
import { recordTabJump, stepTabHistory, useNavHistory } from './view/navHistory';
import { setViewTool, useViewTool } from './view/viewTool';
import { acceptSignedEdit, requestEditTool } from './edit/editTool';
import { SignedWarningDialog } from './edit/signedWarning';
import type { CommentToolId } from './comments/tools';
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
import { downloadBytes } from './files/downloads';
import { createSaver } from './save/saver';
import { reportSaveOutcome } from './save/saveReport';
import { pdfFileName } from './save/fileName';
import { SaveAsDialog } from './save/SaveAsDialog';
import { toasts } from './feedback/toasts';
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
  viewTool: 'select',
  commentTool: null,
  redacting: false,
  canApplyRedactions: false,
  canGoBack: false,
  canGoForward: false,
  view: null,
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
  // About Elanero (W4.3a S4), from the app menu.
  const [aboutOpen, setAboutOpen] = useState(false);
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
  const [extractImagesOpen, setExtractImagesOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  // Redaction Properties (W4.14): the style of new marks. It needs no document.
  const [redactionPropsOpen, setRedactionPropsOpen] = useState(false);
  // Mark Pages (W4.13): the dialog that marks whole pages. Opens only with a document.
  const [markPagesOpen, setMarkPagesOpen] = useState(false);
  // The comment tool on in the open document (W7.1a), as the view reports it for the ribbon's
  // pressed state (W4.3a S7). Apply Redactions asks first, as the toolbar's Apply does.
  const [commentTool, setCommentToolState] = useState<CommentToolId | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [sanitizeOpen, setSanitizeOpen] = useState(false);
  const [flattenOpen, setFlattenOpen] = useState(false);
  const [commentsExportOpen, setCommentsExportOpen] = useState(false);
  const [commentsImportOpen, setCommentsImportOpen] = useState(false);
  // The tab Save As is asked about (W4.9): the dialog is open while it is set.
  const [saveAsTab, setSaveAsTab] = useState<DocumentTab | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const docs = useDocuments(engine);
  // The crop dialog's session (W4.11 S5): the form kept across Draw on page and Esc, and the box
  // drawn on a page, if any. A change of tab clears it and leaves the crop box tool.
  // The tab whose Edit tool waits for the signed-document warning (W6.7a S4), or null.
  const [signedEditAsk, setSignedEditAsk] = useState<number | null>(null);
  const crop = useCropSession(
    docs.tabs.activeId,
    docs.tabs.tabs.map((tab) => tab.id),
  );
  // The Save flow of the open tabs (W4.8): one saver for the page, one save at a time per document.
  const saver = useMemo(
    () => createSaver({ client: () => engine.client(), download: downloadBytes }),
    [engine],
  );
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
    'keyboard-shortcuts': () => openCommandPalette({ view: 'shortcuts' }),
    // Help opens the guide's start; the "?" button opens the page of the tab shown instead.
    help: () => openGuide(),
    'whats-different': () => openGuide(WEB_VERSION_PAGE),
    'about-elanero': () => setAboutOpen(true),
    print: () => setPrintOpen(true),
    open: () => docs.openPicker(),
    'open-recent': () => docs.showStartPage(),
    'split-document': () => setSplitOpen(true),
    'export-pdf': () => setExportOpen(true),
    'extract-images': () => setExtractImagesOpen(true),
    'reduce-file-size': () => setCompressOpen(true),
    'combine-files-into-pdf': () => setCombineOpen(true),
    'document-properties': () => setPropertiesOpen(true),
    'redaction-properties': () => setRedactionPropsOpen(true),
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
  // One redaction controller per open session too (W7.4b): the toolbar and the redactions panel
  // read the same list of the document's marks.
  const redaction = useMemo(
    () =>
      session === null || scheduler === null
        ? null
        : new RedactionController({
            rpc: session.rpc,
            handle: session.handle,
            scheduler,
            startWorker: jobs.acquire,
          }),
    [session, scheduler, jobs],
  );
  // The rail count of the redactions panel reads the same document marks as the toolbar (W7.4b S4).
  const redactionState = useRedactionState(redaction);
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
  // The apply confirmation belongs to the tab it was opened on: a switch of tab closes it, so Apply
  // never runs on another tab's controller. The reset happens while rendering, not in an effect.
  const [applyTab, setApplyTab] = useState(activeId);
  if (applyTab !== activeId) {
    setApplyTab(activeId);
    setApplyOpen(false);
  }
  // Closing a tab closes the confirmation too, whichever tab it is.
  const closeTab = (id: number) => {
    setApplyOpen(false);
    docs.closeTab(id);
  };
  // Save writes the document as a download under its own name, and marks it clean (W4.8).
  const saveTab = async (tab: DocumentTab): Promise<void> => {
    const outcome = await saver.save(
      {
        handle: tab.handle,
        name: pdfFileName(tab.name, t('save.untitled')),
        signed: tab.signed,
        restored: tab.restored,
      },
      'in_place',
    );
    reportSaveOutcome(outcome, downloadBytes, toasts, () => {
      setSaveAsTab(tab);
    });
  };
  // Save As (W4.9) writes a full copy under the name the dialog gave. The copy is then the file the
  // tab is named after, so the tab takes the name; a refused or blocked copy leaves the tab as it was.
  const saveAsCopy = async (tab: DocumentTab, name: string): Promise<void> => {
    const outcome = await saver.save(
      { handle: tab.handle, name, signed: tab.signed, restored: tab.restored },
      'copy',
    );
    if (outcome.status === 'saved') docs.renameTab(tab.id, outcome.name);
    reportSaveOutcome(outcome, downloadBytes);
  };
  // The page and zoom the document view reports, for the status bar under the document.
  const [viewState, setViewState] = useState<DocumentViewState>({
    page: 1,
    zoom: DEFAULT_ZOOM,
    layout: 'continuous',
    labels: [],
    pageCount: 0,
    fit: null,
    firstAlone: false,
    night: false,
  });
  // The night flag the view last reported (or the one this handler set since). Night Mode flips
  // this, not the render's copy, so two toggles before a re-render still flip twice.
  const nightRef = useRef(false);
  const onViewChange = useCallback((next: DocumentViewState) => {
    nightRef.current = next.night;
    setViewState(next);
  }, []);
  // A jump or a thumbnail click that moves the view by more than a page is recorded per tab; Back
  // and Forward move through it (W5.3).
  const history = useNavHistory(activeId);
  // The view tool of the open tab (W4.10): Select or Hand. It is view state, not a document change.
  const viewTool = useViewTool(activeId);
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
    // The engine's flags, from the tab's state events (W4.8 S1); no document means none.
    canUndo: documentShown && activeTab !== undefined && activeTab.canUndo,
    canRedo: documentShown && activeTab !== undefined && activeTab.canRedo,
    ribbonCompact: ribbonPrefs.compact,
    ribbonCollapsed: ribbonPrefs.collapsed,
    viewTool,
    commentTool: documentShown ? commentTool : null,
    redacting: documentShown && (redactionState?.active ?? false),
    canApplyRedactions:
      documentShown &&
      redactionState !== null &&
      !redactionState.busy &&
      redactionState.marks.length > 0,
    redactionBusy: documentShown && (redactionState?.busy ?? false),
    canGoBack: canGoBack(history),
    canGoForward: canGoForward(history),
    view: documentShown
      ? {
          page: viewState.page,
          pageCount: viewState.pageCount,
          zoom: viewState.zoom,
          fit: viewState.fit,
          layout: viewState.layout,
          firstAlone: viewState.firstAlone,
          night: viewState.night,
        }
      : null,
  };
  // The View zoom and Home navigate commands run on the open document's view (W4.2a S6). The view is
  // read when a command runs, not during render; with no document no handler is given, and the
  // registry's "needs a document" rule applies first.
  const runView = useCallback((id: ViewCommandId) => {
    const view = viewRef.current;
    if (view !== null) runViewCommand(id, view);
  }, []);
  // A crop (or its Undo) changes the page sizes and the visible space: the search marks name the
  // old positions, and the view and thumbnails mount again to read the new sizes.
  const onCropped = (changed: ChangedDto | null) => {
    setSearchMarks(null);
    setStructureRevision((value) => value + 1);
    scheduler?.noteRevisions(changed?.revisions ?? {});
  };
  // Undo and Redo (W4.3a S8) run the engine's own history. A step that changed pages redraws them;
  // one that changed the structure or the outline remounts the lists, as a crop does.
  const onHistoryStep = (reply: HistoryResult) => {
    scheduler?.noteRevisions(reply.changed?.revisions ?? {});
    if (reply.changed?.changes.some((c) => c.kind === 'structure' || c.kind === 'outline')) {
      setStructureRevision((value) => value + 1);
    }
  };
  const runHistory = (direction: HistoryDirection) => {
    if (session !== null) {
      void runHistoryStep(direction, {
        rpc: session.rpc,
        handle: session.handle,
        onDone: onHistoryStep,
      });
    }
  };
  const handlers: CommandHandlers = {
    ...baseHandlers,
    ...(documentShown
      ? {
          // Go to Page (W4.3b) focuses the canvas pill's page field.
          'go-to-page': () => viewRef.current?.focusPageField(),
          // Mark Pages (W4.13) opens the dialog that marks whole pages; nothing is applied.
          'mark-whole-pages': () => {
            if (redaction === null) {
              toasts.push('info', t('redact.notReady'));
              return;
            }
            setMarkPagesOpen(true);
          },
          // Mark Text (W4.12) marks the browser's selection on the view's pages; nothing is applied.
          'mark-text': () => {
            const view = viewRef.current;
            if (redaction === null || view === null) {
              toasts.push('info', t('redact.notReady'));
              return;
            }
            void markSelectedText({
              controller: redaction,
              selection: window.getSelection(),
              lookup: (page) => view.cachedLines(page),
            });
          },
          // Comment tools (W7.1a) are toggles: choosing the tool that is on turns it off.
          'sticky-note': () =>
            viewRef.current?.setCommentTool(commentTool === 'note' ? null : 'note'),
          highlight: () =>
            viewRef.current?.setCommentTool(commentTool === 'highlight' ? null : 'highlight'),
          rectangle: () =>
            viewRef.current?.setCommentTool(commentTool === 'rectangle' ? null : 'rectangle'),
          // Redact (W7.4) turns the mark tool on or off, as the toolbar's Mark button does.
          redact: () => viewRef.current?.setRedacting(!state.redacting),
          // Apply Redactions (W7.4) asks for the same confirmation as the toolbar's Apply.
          'apply-redactions': () => setApplyOpen(true),
          'zoom-in': () => runView('zoom-in'),
          'zoom-out': () => runView('zoom-out'),
          'fit-width': () => runView('fit-width'),
          'fit-page': () => runView('fit-page'),
          'actual-size': () => runView('actual-size'),
          // The page layouts and night reading (W4.3a S6) set the view's own state, so the ribbon's
          // pressed state follows the view as it reports back.
          'single-page-continuous': () =>
            viewRef.current?.setLayout({ layout: 'continuous', firstAlone: false }),
          'two-up-continuous': () =>
            viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: false }),
          'two-up-with-cover-page': () =>
            viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: true }),
          'night-reading': () => {
            const next = !nightRef.current;
            nightRef.current = next;
            viewRef.current?.setNight(next);
          },
          // Organize Pages opens the organizer panel on the right, as its rail button does.
          'organize-pages': () => openPanel('organizer'),
          // Select and Hand (W4.10). Hand pressed again returns to Select, as on the desktop.
          'select-tool': () => {
            if (activeId !== null) setViewTool(activeId, 'select');
          },
          'hand-tool': () => {
            if (activeId !== null) setViewTool(activeId, viewTool === 'hand' ? 'select' : 'hand');
          },
          'previous-page': () => runView('previous-page'),
          'next-page': () => runView('next-page'),
          back: () => stepBack(-1),
          forward: () => stepBack(1),
          // Save (W4.8) writes the open document back as a download; Ctrl+S runs it too.
          save: () => {
            if (activeTab !== undefined) void saveTab(activeTab);
          },
          // Undo and Redo (W4.3a S8): the engine's history; the tab's flags say what is possible.
          undo: () => runHistory('undo'),
          redo: () => runHistory('redo'),
          // Crop (W4.11) opens the crop dialog for the open document.
          'crop-pages': () => crop.openDialog(),
          // Edit Text & Images (W6.7a S4) turns the Edit tool on; a signed document asks once per tab.
          'edit-text-images': () => {
            if (activeId === null) return;
            if (!requestEditTool(activeId, activeTab?.signed ?? false)) setSignedEditAsk(activeId);
          },
          // Delete Objects (W6.7a S5) deletes the Edit tool's selection; with none, nothing happens.
          'delete-selected-objects': () => viewRef.current?.deleteEditSelection(),
          // Save As (W4.9) asks for a name, then writes a full copy under it.
          'save-as': () => {
            if (activeTab !== undefined) setSaveAsTab(activeTab);
          },
          // Close (W4.3a S4) closes the open tab, as the tab's own close button does.
          close: () => {
            if (activeId !== null) closeTab(activeId);
          },
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
            panel="redactions"
            label={t('redactions.title')}
            icon={RAIL_ICONS.redactions}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
            count={redactionState?.marks.length ?? 0}
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
        ) : documentShown &&
          leftPanelOpen === 'redactions' &&
          activeId !== null &&
          redaction !== null ? (
          <RedactionsPanel
            key={activeId}
            controller={redaction}
            onGoTo={goTo}
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
              <QuickAccess registry={REGISTRY} state={state} handlers={handlers} />
            </div>
            <DocumentTabs state={docs.tabs} onSelect={docs.selectTab} onClose={closeTab} />
            <button
              type="button"
              className="app-header-prefs"
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
      <RedactionPropertiesDialog
        isOpen={redactionPropsOpen}
        onClose={() => setRedactionPropsOpen(false)}
      />
      <ApplyConfirm
        isOpen={applyOpen}
        count={redactionState?.marks.length ?? 0}
        onCancel={() => setApplyOpen(false)}
        onConfirm={() => {
          setApplyOpen(false);
          if (redaction !== null) void redaction.apply(null);
        }}
      />
      <PreferencesDialog
        isOpen={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        // Any open tab counts, including one still loading or behind the start page (Open Recent):
        // clearing reloads the page, which would lose its unsaved edits. A file still queued or
        // opening (docs.pending) counts too: it can finish while the confirmation is showing.
        hasDocuments={docs.tabs.tabs.length > 0 || docs.pending.length > 0}
        onShowShortcuts={() => setShortcutsOpen(true)}
      />
      <SaveAsDialog
        tab={saveAsTab}
        onCancel={() => {
          setSaveAsTab(null);
        }}
        onSave={(name) => {
          const tab = saveAsTab;
          setSaveAsTab(null);
          if (tab !== null) void saveAsCopy(tab, name);
        }}
      />
      <Overlay isOpen={aboutOpen} onClose={() => setAboutOpen(false)} title={t('about.title')}>
        <About />
      </Overlay>
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
      {documentShown && session !== null && activeTab !== undefined && rpc !== undefined ? (
        <ExtractImagesDialog
          isOpen={extractImagesOpen}
          onClose={() => setExtractImagesOpen(false)}
          engine={rpc}
          handle={session.handle}
          name={activeTab.name}
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
      {documentShown && session !== null && activeTab !== undefined && redaction !== null ? (
        <MarkPagesDialog
          isOpen={markPagesOpen}
          onClose={() => setMarkPagesOpen(false)}
          controller={redaction}
          rpc={session.rpc}
          handle={session.handle}
          pageCount={activeTab.pages}
          currentPage={viewState.page}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <CropDialog
          isOpen={crop.open}
          onClose={crop.close}
          rpc={session.rpc}
          handle={session.handle}
          pageCount={activeTab.pages}
          currentPage={crop.scopePage ?? viewState.page}
          signed={activeTab.signed}
          onChanged={onCropped}
          initialValues={crop.values}
          onValuesChange={crop.setValues}
          drawn={crop.drawn}
          onDrawOnPage={crop.drawOnPage}
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
      <SignedWarningDialog
        isOpen={signedEditAsk !== null}
        onAccept={() => {
          if (signedEditAsk !== null) acceptSignedEdit(signedEditAsk);
          setSignedEditAsk(null);
        }}
        onCancel={() => setSignedEditAsk(null)}
      />
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
            redaction={redaction ?? undefined}
            onViewChange={onViewChange}
            startWorker={jobs.acquire}
            tool={viewTool}
            onToolChange={(tool) => {
              if (activeId !== null) setViewTool(activeId, tool);
            }}
            onCropBoxEnd={crop.boxEnded}
            onCommentToolChange={setCommentToolState}
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
