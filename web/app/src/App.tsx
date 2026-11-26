import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { About } from './about';
import { REGISTRY } from './commands/catalog';
import { type CommandHandlers, runCommand } from './commands/run';
import { type CommandState } from './commands/registry';
import { t } from './i18n/t';
import { EngineLoadingScreen } from './feedback/LoadingScreen';
import type { EngineConnection } from './engine/engineConnection';
import type { FontLibrary } from './fonts/fontLibrary';
import { clearDataAndNotify, clearLocalData } from './storage/clearLocalData';
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
import { EncryptDialog } from './security/EncryptDialog';
import { RemoveSecurityDialog } from './security/RemoveSecurityDialog';
import { PropertiesDialog } from './properties/PropertiesDialog';
import { CommandPalette } from './palette/CommandPalette';
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
import { BackgroundDialog } from './marks/BackgroundDialog';
import { HeaderFooterDialog } from './marks/HeaderFooterDialog';
import { WatermarkDialog } from './marks/WatermarkDialog';
import { CropDialog } from './crop/CropDialog';
import { useCropSession } from './crop/useCropSession';
import type { ChangedDto, HistoryResult, TranslateParams } from './rpc/generated';
import { type HistoryDirection, historyRefresh, runHistoryStep } from './history/runHistory';
import { CommentsExportDialog } from './commentsExport/CommentsExportDialog';
import { CommentsImportDialog } from './commentsImport/CommentsImportDialog';
import { SplitDialog } from './split/SplitDialog';
import { ExportDialog } from './export/ExportDialog';
import { ExtractFontsDialog } from './extract/ExtractFontsDialog';
import { ExtractImagesDialog } from './extract/ExtractImagesDialog';
import { CompressDialog } from './compress/CompressDialog';
import { SpaceUsageDialog } from './space/SpaceUsageDialog';
import { CompareDialog } from './compare/CompareDialog';
import { ApplyConfirm } from './redaction/ApplyConfirm';
import { RedactionController } from './redaction/controller';
import { MarkPagesDialog } from './redaction/MarkPagesDialog';
import { markSelectedText } from './redaction/markText';
import { copySelectedText } from './text/copy';
import { type TranslateFlowHandle, TranslateFlow } from './translate/TranslateFlow';
import { copyLarge } from './text/largeCopy';
import { RedactionsPanel } from './redaction/RedactionsPanel';
import { RedactionPropertiesDialog } from './redaction/RedactionPropertiesDialog';
import { ShapeStyleDialog } from './edit/ShapeStyleDialog';
import { useRedactionState } from './redaction/useRedaction';
import { type DocumentViewHandle, type DocumentViewState, DocumentView } from './view/DocumentView';
import { DocumentStatusBar } from './view/DocumentStatusBar';
import { type ViewCommandId, runViewCommand } from './view/viewCommands';
import { recordTabJump, stepTabHistory, useNavHistory } from './view/navHistory';
import { setViewTool, type ShapeTool, useViewTool } from './view/viewTool';
import { chooseImage, dropPendingImage, setPendingImage } from './edit/images';
import { acceptSignedEdit, type EditTool, requestEditTool } from './edit/editTool';
import { SignedWarningDialog } from './edit/signedWarning';
import { CommentsPanel } from './comments/panel/CommentsPanel';
import { CommentsController } from './comments/panel/controller';
import { useCommentsCount } from './comments/panel/useComments';
import { type CommentToolId, toggleCommentTool } from './comments/tools';
import { MARKUP_COMMAND_KINDS, type MarkupKind, pressMarkup } from './comments/markup';
import { createStampLibrary } from './comments/stampLibrary';
import { StampMenu } from './comments/stampTool';
import { canGoBack, canGoForward } from './view/navigation';
import { DEFAULT_ZOOM } from './view/zoom';
import { RenderScheduler } from './view/renderScheduler';
import { BookmarksPanel } from './bookmarks/BookmarksPanel';
import { AttachmentsPanel } from './attachments/AttachmentsPanel';
import { LayersPanel } from './layers/LayersPanel';
import { ThumbnailsPanel } from './thumbnails/ThumbnailsPanel';
import { OrganizerPanel } from './organizer/OrganizerPanel';
import { type FindRequest, SearchPanel } from './search/SearchPanel';
import type { SearchMarks } from './search/search';
import { RailButton } from './layout/RailButton';
import { RAIL_ICONS } from './layout/railIcons';
import { closePanel, openPanel, togglePanel, useOpenPanel } from './layout/sidePanels';
import { downloadBytes } from './files/downloads';
import { createSaver, type SaveOutcome } from './save/saver';
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
  contentEdit: false,
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
  // The tab's uploaded fonts (W6.9 slice 3); the font UI (slice 4) reads them. Tests leave it out.
  readonly fonts?: FontLibrary;
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
  fonts,
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
  // F3 and Shift+F3 (W5.4 S5): a request for the search panel to step. Its id makes each one new.
  const [findRequest, setFindRequest] = useState<FindRequest | undefined>(undefined);
  const findCount = useRef(0);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // The translation languages and privacy link, read from the engine when the page opens (W6.6).
  const loadTranslationInfo = useCallback(
    async () => (await engine.whenReady()).call('translation.info', {}),
    [engine],
  );
  // The bubble's translation call (W6.6): the engine's gated network path, once the user agreed.
  const translateCall = useCallback(
    async (params: TranslateParams) =>
      (await engine.whenReady()).call('translation.translate', params),
    [engine],
  );
  // The translate flow of the open document (the Translate command and the selection toolbar).
  const translateFlow = useRef<TranslateFlowHandle>(null);
  const getView = useCallback(() => viewRef.current, []);
  // About Elanero (W4.3a S4), from the app menu.
  const [aboutOpen, setAboutOpen] = useState(false);
  // Keyboard Shortcuts (W4.5 S2): opened from Preferences only. It opens above Preferences, which
  // keeps its unsaved draft.
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
  const [extractFontsOpen, setExtractFontsOpen] = useState(false);
  const [compressOpen, setCompressOpen] = useState(false);
  const [spaceUsageOpen, setSpaceUsageOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [combineOpen, setCombineOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [encryptOpen, setEncryptOpen] = useState(false);
  const [removeSecurityOpen, setRemoveSecurityOpen] = useState(false);
  // Redaction Properties (W4.14): the style of new marks. It needs no document.
  const [redactionPropsOpen, setRedactionPropsOpen] = useState(false);
  // Shape Style (W6.7b slice 3a): the outline, fill and width of the shapes drawn next. No document.
  const [shapeStyleOpen, setShapeStyleOpen] = useState(false);
  // Mark Pages (W4.13): the dialog that marks whole pages. Opens only with a document.
  const [markPagesOpen, setMarkPagesOpen] = useState(false);
  // The comment tool on in the open document (W7.1a), as the view reports it for the ribbon's
  // pressed state (W4.3a S7). Apply Redactions asks first, as the ribbon's Apply does.
  const [commentTool, setCommentToolState] = useState<CommentToolId | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [sanitizeOpen, setSanitizeOpen] = useState(false);
  const [flattenOpen, setFlattenOpen] = useState(false);
  // Background (W7.3): the marks dialog for a colour behind the page content.
  const [backgroundOpen, setBackgroundOpen] = useState(false);
  // Header & Footer and Bates numbers (W7.3 S3): one dialog, in the mode its command opened.
  const [headerFooterMode, setHeaderFooterMode] = useState<'headerFooter' | 'bates' | null>(null);
  // Watermark (W7.3 S4): the text mode of the watermark dialog.
  const [watermarkOpen, setWatermarkOpen] = useState(false);
  const [commentsExportOpen, setCommentsExportOpen] = useState(false);
  const [commentsImportOpen, setCommentsImportOpen] = useState(false);
  // The tab Save As is asked about (W4.9): the dialog is open while it is set.
  const [saveAsTab, setSaveAsTab] = useState<DocumentTab | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const docs = useDocuments(engine);
  // The crop dialog's session (W4.11 S5): the form kept across Draw on page and Esc, and the box
  // drawn on a page, if any. A change of tab clears it and leaves the crop box tool.
  // The tab, and the tool, whose Edit or shape tool waits for the signed-document warning (W6.7a
  // S4, W6.7b), or null.
  const [signedEditAsk, setSignedEditAsk] = useState<{ tabId: number; tool: EditTool } | null>(
    null,
  );
  const crop = useCropSession(
    docs.tabs.activeId,
    docs.tabs.tabs.map((tab) => tab.id),
  );
  // The Save flow of the open tabs (W4.8): one saver for the page, one save at a time per document.
  const saver = useMemo(
    () => createSaver({ client: () => engine.client(), download: downloadBytes }),
    [engine],
  );
  // Clear all local data (W6.9 slice 3): when it succeeds, the other tabs drop their copies of the
  // uploaded fonts. This tab reloads after the clear, so it needs no more than that.
  const clearData = useCallback(() => clearDataAndNotify(clearLocalData, fonts), [fonts]);
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
  // F3 and Shift+F3 step through the hits of the open search. With the panel closed they open it.
  const requestFind = (direction: 1 | -1) => {
    if (!documentShown) return;
    if (leftPanelOpen !== 'search') {
      openPanel('search');
      return;
    }
    findCount.current += 1;
    setFindRequest({ direction, id: findCount.current });
  };
  const baseHandlers: CommandHandlers = {
    preferences: () => setPreferencesOpen(true),
    'next-document': () => cycleDocument(1),
    'previous-document': () => cycleDocument(-1),
    'collapse-ribbon': () => setRibbonChoice({ ...ribbonPrefs, collapsed: !ribbonPrefs.collapsed }),
    'compact-ribbon': () => setRibbonChoice({ ...ribbonPrefs, compact: !ribbonPrefs.compact }),
    // The editable Keyboard Shortcuts dialog (W4.x), the same one Preferences opens.
    'keyboard-shortcuts': () => setShortcutsOpen(true),
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
    'extract-fonts': () => setExtractFontsOpen(true),
    'reduce-file-size': () => setCompressOpen(true),
    'space-usage': () => setSpaceUsageOpen(true),
    'combine-files-into-pdf': () => setCombineOpen(true),
    'document-properties': () => setPropertiesOpen(true),
    'encrypt-with-password': () => setEncryptOpen(true),
    'remove-security': () => setRemoveSecurityOpen(true),
    'redaction-properties': () => setRedactionPropsOpen(true),
    'shape-style': () => setShapeStyleOpen(true),
    'sanitize-document': () => setSanitizeOpen(true),
    'compare-files': () => setCompareOpen(true),
    'flatten-all-comments': () => setFlattenOpen(true),
    'export-comments': () => setCommentsExportOpen(true),
    'import-comments': () => setCommentsImportOpen(true),
    // The Comments panel (W7.1b): shows it, as the desktop's Comments List does (not a toggle).
    'comments-list': () => openPanel('comments'),
    // Copy (Ctrl+C) copies the selection over the page text, as the desktop does (W5.4 S4): the
    // model's (a drag or Select All), or the browser's under Hand. A large selection is copied in
    // slices by the engine of the active tab (W5.4, largeCopy.ts).
    copy: () =>
      copySelectedText({
        selection: window.getSelection(),
        lookup: (page) => viewRef.current?.cachedLines(page),
        clipboard: navigator.clipboard,
        plan: () => viewRef.current?.copyPlan() ?? { kind: 'off' },
        large: (plan) => {
          if (session === null) return;
          copyLarge(
            {
              rpc: session.rpc,
              handle: session.handle,
              clipboard: navigator.clipboard,
              store: toasts,
            },
            plan,
          );
        },
      }),
    // Ctrl+F: the search panel, on the left, with focus in its query box (also when it is open).
    find: () => {
      openPanel('search');
      setSearchFocus((count) => count + 1);
    },
    'find-next': () => requestFind(1),
    'find-previous': () => requestFind(-1),
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
  // One redaction controller per open session too (W7.4b): the ribbon and the redactions panel
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
  // The rail count of the redactions panel reads the same document marks as the ribbon (W7.4b S4).
  const redactionState = useRedactionState(redaction);
  // The custom stamp library the Comment tab's Stamp menu reads: one per open session, as the view
  // kept it before the menu moved to the ribbon (a session's held stamps stay with its document).
  const stampLibrary = useMemo(() => (session === null ? null : createStampLibrary()), [session]);
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
  // The layers panel reads its list again after a change that moves the structure (a snapshot
  // restore). A layer toggle replies with the list only, so its change event is what redraws the
  // pages it names. A restart reopens the document under a new handle, which the panel reads again.
  const [layersRevision, setLayersRevision] = useState(0);
  const sessionHandle = session?.handle;
  useEffect(
    () =>
      engine.onEvents((events) => {
        for (const event of events) {
          if (event.kind !== 'changed' || event.handle !== sessionHandle) continue;
          scheduler?.noteRevisions(event.revisions);
          if (event.changes.some((change) => change.kind === 'structure')) {
            setLayersRevision((value) => value + 1);
          }
        }
      }),
    [engine, sessionHandle, scheduler],
  );
  const viewRef = useRef<DocumentViewHandle>(null);
  // Bumped after the page organizer changes the pages: the view and the thumbnails then mount again
  // and read the page list from the engine.
  const [structureRevision, setStructureRevision] = useState(0);
  // Bumped after an Undo or Redo that changed only the outline: the bookmarks reload, and the view
  // stays where the reader is (a remount would put it back on page 1).
  const [outlineRevision, setOutlineRevision] = useState(0);
  // Bumped after an Undo or Redo: an add or a remove of an attachment changes no page, so the
  // attachments panel reloads its list on this counter.
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
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
  // The comments list of the open session (W7.1b S3): one read-only controller, shared by the panel
  // and the rail count. It stays in step with the document while it runs, and reads the list only
  // while the Comments panel is open.
  const comments = useMemo(
    () =>
      session === null || scheduler === null
        ? null
        : new CommentsController({ rpc: session.rpc, handle: session.handle, scheduler }),
    [session, scheduler],
  );
  useEffect(() => (comments === null ? undefined : comments.start()), [comments]);
  const commentsOpen = documentShown && leftPanelOpen === 'comments';
  useEffect(() => {
    if (comments === null) return undefined;
    comments.setOpen(commentsOpen);
    return () => comments.setOpen(false);
  }, [comments, commentsOpen]);
  const commentsCount = useCommentsCount(comments);
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
      id: 'attachments',
      label: t('attachments.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('attachments');
      },
    },
    {
      id: 'layers',
      label: t('layers.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('layers');
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
    {
      id: 'comments',
      label: t('comments.title'),
      disabled: !documentShown,
      onAction: () => {
        togglePanel('comments');
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
    // The shown tab's paragraph editor drops its typing (it is offered as a toast), not commits it.
    if (id === activeId) viewRef.current?.dropTextEdit();
    docs.closeTab(id);
  };
  // A save that reached the engine names unnamed comments (a full save), so the list is read again.
  // A blocked download still ran the save in the engine, so it counts too.
  const afterSave = (tab: DocumentTab, outcome: SaveOutcome): void => {
    if (
      (outcome.status === 'saved' || outcome.status === 'download-blocked') &&
      tab.handle === session?.handle
    ) {
      comments?.noteChange();
    }
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
    afterSave(tab, outcome);
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
    afterSave(tab, outcome);
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
  // Whether the Edit tool has exactly one picture selected, as the view reports it (W6.7b slice 2b).
  const [editImageOne, setEditImageOne] = useState(false);
  const onEditImageChange = useCallback((single: boolean) => setEditImageOne(single), []);
  // How many comments the Select tool has selected (the Delete comment command, issue 732).
  const [commentSelectionCount, setCommentSelectionCount] = useState(0);
  const onCommentSelectionChange = useCallback(
    (count: number) => setCommentSelectionCount(count),
    [],
  );
  // A jump or a thumbnail click that moves the view by more than a page is recorded per tab; Back
  // and Forward move through it (W5.3).
  const history = useNavHistory(activeId);
  // The view tool of the open tab (W4.10): Select or Hand. It is view state, not a document change.
  const viewTool = useViewTool(activeId);
  const goTo = (index: number) => {
    if (activeId !== null) recordTabJump(activeId, viewState.page - 1, index);
    viewRef.current?.scrollToPage(index);
  };
  // A link to a page of this document (W5.3) is a jump like any other: it lands at the link's
  // target and is recorded in the tab's history.
  const onLinkGoTo = (index: number, top: number | null) => {
    if (activeId !== null) recordTabJump(activeId, viewState.page - 1, index);
    viewRef.current?.scrollToPage(index, top ?? undefined);
  };
  const stepBack = (direction: -1 | 1) => {
    if (activeId === null) return;
    const page = stepTabHistory(activeId, direction);
    if (page !== null) viewRef.current?.scrollToPage(page);
  };
  // The document's name without its .pdf suffix, for the name of an exported picture.
  const documentStem = pdfFileName(activeTab?.name ?? '', t('save.untitled')).replace(
    /\.pdf$/i,
    '',
  );
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
    // The engine's content_edit flag (W6.7a): the Edit tool's commands are off without it.
    contentEdit: documentShown && (activeTab?.contentEdit ?? false),
    // Exactly one picture selected in the Edit tool (W6.7b slice 2b): Replace and Export need it.
    singleImageSelected: documentShown && editImageOne,
    commentsSelected: documentShown && commentSelectionCount > 0,
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
  // one that changed the structure remounts the view and the lists, as a crop does; one that changed
  // only the outline reloads the bookmarks.
  const onHistoryStep = (reply: HistoryResult) => {
    scheduler?.noteRevisions(reply.changed?.revisions ?? {});
    comments?.noteChange();
    const refresh = historyRefresh(reply.changed);
    if (refresh.structure) setStructureRevision((value) => value + 1);
    else if (refresh.outline) setOutlineRevision((value) => value + 1);
    if (reply.done) setAttachmentsRevision((value) => value + 1);
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
  // A shape tool or Add Text toggles like the Edit tool: a second press returns to Select. A signed
  // document asks once per tab first, as the Edit tool does (W6.7b, W6.8a 8a-2).
  const toggleEditTool = (tool: ShapeTool | 'add-text') => {
    if (activeId === null) return;
    if (viewTool === tool) {
      setViewTool(activeId, 'select');
      return;
    }
    if (!requestEditTool(activeId, activeTab?.signed ?? false, tool))
      setSignedEditAsk({ tabId: activeId, tool });
  };
  // Replace Image (W6.7b slice 2b): the file is picked from this click and checked, then the Edit
  // tool replaces its one selected picture with it. A refused file changes nothing.
  const replaceImageFromPicker = async () => {
    const file = await chooseImage();
    if (file !== null) viewRef.current?.replaceEditImage(file);
  };
  // Add Image (W6.7b slice 2a): the file is picked first, from this click, and checked. The Image
  // tool then places it. A signed document asks once per tab, as the other edit tools do; a
  // refused file never turns the tool on.
  const addImageFromPicker = async () => {
    const tab = activeId;
    if (tab === null) return;
    const signed = activeTab?.signed ?? false;
    const file = await chooseImage();
    if (file === null) return;
    setPendingImage(tab, file);
    if (!requestEditTool(tab, signed, 'image')) setSignedEditAsk({ tabId: tab, tool: 'image' });
  };
  // The text markups (W7.1a slice 5) mark the view's text selection, read as Mark Text reads it.
  // With no selection, noSelection runs (Highlight's drag tool; the others say so).
  const pressMarkupCommand = (kind: MarkupKind, noSelection: () => void) => {
    const view = viewRef.current;
    if (view === null || session === null || scheduler === null) {
      toasts.push('info', t('redact.notReady'));
      return;
    }
    void pressMarkup(
      kind,
      {
        rpc: session.rpc,
        handle: session.handle,
        scheduler,
        pageSpan: () => view.selectedPageSpan(),
        model: () => view.selectedAreas(),
        clearModel: () => view.clearTextSelection(),
        loadPages: (pages) => view.loadTextPages(pages),
        selection: window.getSelection(),
        lookup: (page) => view.cachedLines(page),
      },
      noSelection,
    );
  };
  const handlers: CommandHandlers = {
    ...baseHandlers,
    ...(documentShown
      ? {
          // Go to Page (W4.3b) focuses the canvas pill's page field.
          'go-to-page': () => viewRef.current?.focusPageField(),
          // Select All (W5.4 section 2) selects the text of the whole document under Select.
          'select-all': () => viewRef.current?.selectAll(),
          // Mark Pages (W4.13) opens the dialog that marks whole pages; nothing is applied.
          'mark-whole-pages': () => {
            if (redaction === null) {
              toasts.push('info', t('redact.notReady'));
              return;
            }
            setMarkPagesOpen(true);
          },
          // Translate selection (W6.6) opens the bubble for the selected text, after the consent notice.
          'translate-selection': () => translateFlow.current?.translate(),
          // Mark Text (W4.12) marks the text selection on the view's pages (the model's, or the
          // browser's under Hand); nothing is applied.
          'mark-text': () => {
            const view = viewRef.current;
            if (redaction === null || view === null) {
              toasts.push('info', t('redact.notReady'));
              return;
            }
            void markSelectedText({
              controller: redaction,
              pageSpan: () => view.selectedPageSpan(),
              model: () => view.selectedAreas(),
              clearModel: () => view.clearTextSelection(),
              loadPages: (pages) => view.loadTextPages(pages),
              selection: window.getSelection(),
              lookup: (page) => view.cachedLines(page),
            });
          },
          // Comment tools (W7.1a) are toggles: choosing the tool that is on turns it off.
          'sticky-note': () =>
            viewRef.current?.setCommentTool(commentTool === 'note' ? null : 'note'),
          highlight: () =>
            pressMarkupCommand(MARKUP_COMMAND_KINDS.highlight, () =>
              viewRef.current?.setCommentTool(commentTool === 'highlight' ? null : 'highlight'),
            ),
          underline: () => pressMarkupCommand(MARKUP_COMMAND_KINDS.underline, () => undefined),
          strikethrough: () =>
            pressMarkupCommand(MARKUP_COMMAND_KINDS.strikethrough, () => undefined),
          squiggly: () => pressMarkupCommand(MARKUP_COMMAND_KINDS.squiggly, () => undefined),
          rectangle: () =>
            viewRef.current?.setCommentTool(commentTool === 'rectangle' ? null : 'rectangle'),
          'text-box': () =>
            viewRef.current?.setCommentTool(commentTool === 'textbox' ? null : 'textbox'),
          oval: () => viewRef.current?.setCommentTool(commentTool === 'oval' ? null : 'oval'),
          line: () => viewRef.current?.setCommentTool(commentTool === 'line' ? null : 'line'),
          arrow: () => viewRef.current?.setCommentTool(commentTool === 'arrow' ? null : 'arrow'),
          callout: () =>
            viewRef.current?.setCommentTool(commentTool === 'callout' ? null : 'callout'),
          polygon: () =>
            viewRef.current?.setCommentTool(commentTool === 'polygon' ? null : 'polygon'),
          polyline: () =>
            viewRef.current?.setCommentTool(commentTool === 'polyline' ? null : 'polyline'),
          pen: () => viewRef.current?.setCommentTool(commentTool === 'pen' ? null : 'pen'),
          // Attach File (issue 732) is a toggle like the other comment tools: the next click asks for a file.
          'attach-file': () =>
            viewRef.current?.setCommentTool(commentTool === 'attach' ? null : 'attach'),
          // The ribbon's Stamp toggles the stamp tool with the stamp last chosen in the stamp menu.
          stamp: () =>
            toggleCommentTool(commentTool, 'stamp', (tool) =>
              viewRef.current?.setCommentTool(tool),
            ),
          // Redact (W7.4) turns the mark tool on or off, as the ribbon's Mark button does.
          redact: () => viewRef.current?.setRedacting(!state.redacting),
          // Apply Redactions (W7.4) asks for the same confirmation as the ribbon's Apply.
          'apply-redactions': () => setApplyOpen(true),
          // Clear marks drops every mark at once, with no confirmation (as the strip's Clear did).
          'clear-redaction-marks': () => {
            if (redaction !== null) void redaction.clear();
          },
          'zoom-in': () => runView('zoom-in'),
          'zoom-out': () => runView('zoom-out'),
          'fit-width': () => runView('fit-width'),
          'fit-page': () => runView('fit-page'),
          'actual-size': () => runView('actual-size'),
          // The page layouts and night reading (W4.3a S6) set the view's own state, so the ribbon's
          // pressed state follows the view as it reports back.
          'single-page': () => viewRef.current?.setLayout({ layout: 'single', firstAlone: false }),
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
          // Background (W7.3) opens the marks dialog; the other marks follow in their slices.
          'add-background': () => setBackgroundOpen(true),
          'add-header-footer': () => setHeaderFooterMode('headerFooter'),
          'add-bates-numbers': () => setHeaderFooterMode('bates'),
          'add-watermark': () => setWatermarkOpen(true),
          // Edit Text & Images (W6.7a S4) turns the Edit tool on; a signed document asks once per tab.
          'edit-text-images': () => {
            if (activeId === null) return;
            if (!requestEditTool(activeId, activeTab?.signed ?? false))
              setSignedEditAsk({ tabId: activeId, tool: 'edit' });
          },
          // The shape tools (W6.7b) draw one shape each, then return to Select.
          'add-rectangle': () => toggleEditTool('shape-rectangle'),
          'add-ellipse': () => toggleEditTool('shape-ellipse'),
          'add-line': () => toggleEditTool('shape-line'),
          // Add Text (W6.8a 8a-2): a click or drag places one text block, then the tool returns to Select.
          'add-text': () => toggleEditTool('add-text'),
          'add-image': () => void addImageFromPicker(),
          // Replace and Export (W6.7b slice 2b) act on the Edit tool's one selected picture. Export
          // names its file after the document.
          'replace-image': () => void replaceImageFromPicker(),
          'extract-image': () => viewRef.current?.exportEditImage(documentStem),
          // Delete Objects (W6.7a S5) deletes the Edit tool's selection; with none, nothing happens.
          'delete-selected-objects': () => viewRef.current?.deleteEditSelection(),
          // Delete comment (issue 732) deletes the comments the Select tool has selected; with none, nothing happens.
          'delete-comment': () => viewRef.current?.deleteCommentSelection(),
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
  // Controls the ribbon draws inside a group (W8 fix 702): the Comment tab's Stamp menu, and the
  // Protect tab's mark count, which a polite status region announces as it changes.
  const groupExtras: Readonly<Record<string, ReactNode>> = {
    'comment.comments':
      documentShown && stampLibrary !== null ? (
        <StampMenu
          library={stampLibrary}
          onChoose={(chosen) => viewRef.current?.chooseStamp(chosen)}
          onRemoved={(id) => viewRef.current?.stampRemoved(id)}
        />
      ) : null,
    'protect.redact': documentShown ? (
      <span role="status" className="ribbon-count">
        {t('redact.count', { count: redactionState?.marks.length ?? 0 })}
      </span>
    ) : null,
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
            panel="attachments"
            label={t('attachments.title')}
            icon={RAIL_ICONS.attachments}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
          />
          <RailButton
            panel="layers"
            label={t('layers.title')}
            icon={RAIL_ICONS.layers}
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
          <RailButton
            panel="comments"
            label={t('comments.title')}
            icon={RAIL_ICONS.comments}
            disabled={!documentShown}
            controlsId={documentShown ? 'app-panel-left' : undefined}
            count={commentsCount}
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
            onReveal={(page, rect) => viewRef.current?.revealRect(page, rect)}
            onClose={() => closePanel('left')}
            focusRequest={searchFocus}
            currentPage={viewState.page - 1}
            findRequest={findRequest}
          />
        ) : documentShown &&
          leftPanelOpen === 'bookmarks' &&
          activeId !== null &&
          session !== null ? (
          <BookmarksPanel
            key={`bookmarks-${activeId}`}
            rpc={session.rpc}
            handle={session.handle}
            tabId={activeId}
            currentPage={viewState.page - 1}
            // Both counters only grow, so their sum changes whenever either does.
            revision={structureRevision + outlineRevision}
            onHistoryStep={onHistoryStep}
            // A bookmark lands where it points, like a link: the same path, with the offset (W5.2 S3).
            onSelect={onLinkGoTo}
            location={() => viewRef.current?.location() ?? null}
            labels={viewState.labels}
            selectedText={() => viewRef.current?.selectedText() ?? null}
            onClose={() => closePanel('left')}
          />
        ) : documentShown &&
          leftPanelOpen === 'attachments' &&
          activeId !== null &&
          session !== null ? (
          <AttachmentsPanel
            key={activeId}
            rpc={session.rpc}
            handle={session.handle}
            revision={attachmentsRevision}
            signed={activeTab?.signed ?? false}
            onHistoryStep={onHistoryStep}
            startWorker={jobs.acquire}
            onOpenFiles={docs.openFiles}
            onClose={() => closePanel('left')}
          />
        ) : documentShown && leftPanelOpen === 'layers' && activeId !== null && session !== null ? (
          <LayersPanel
            key={activeId}
            rpc={session.rpc}
            handle={session.handle}
            revision={layersRevision}
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
        ) : documentShown &&
          leftPanelOpen === 'comments' &&
          activeId !== null &&
          comments !== null &&
          session !== null &&
          scheduler !== null ? (
          <CommentsPanel
            key={activeId}
            controller={comments}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
            onGoTo={(page) => goTo(page)}
            onClose={() => closePanel('left')}
            onImport={() => setCommentsImportOpen(true)}
            onExport={() => setCommentsExportOpen(true)}
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
          <Ribbon registry={REGISTRY} state={state} handlers={handlers} groupExtras={groupExtras} />
        </>
      }
    >
      <RedactionPropertiesDialog
        isOpen={redactionPropsOpen}
        onClose={() => setRedactionPropsOpen(false)}
      />
      <ShapeStyleDialog isOpen={shapeStyleOpen} onClose={() => setShapeStyleOpen(false)} />
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
        clearData={clearData}
        loadTranslationInfo={loadTranslationInfo}
        fonts={fonts}
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
          name={activeTab.name}
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
        <ExtractFontsDialog
          isOpen={extractFontsOpen}
          onClose={() => setExtractFontsOpen(false)}
          engine={rpc}
          handle={session.handle}
          name={activeTab.name}
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
      {documentShown && session !== null && rpc !== undefined ? (
        <SpaceUsageDialog
          isOpen={spaceUsageOpen}
          onClose={() => setSpaceUsageOpen(false)}
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
      {documentShown && session !== null && activeTab !== undefined ? (
        <BackgroundDialog
          isOpen={backgroundOpen}
          onClose={() => setBackgroundOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
          pageCount={activeTab.pages}
          currentPage={viewState.page}
          signed={activeTab.signed}
          onChanged={(changed) => scheduler?.noteRevisions(changed?.revisions ?? {})}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <HeaderFooterDialog
          isOpen={headerFooterMode !== null}
          bates={headerFooterMode === 'bates'}
          onClose={() => setHeaderFooterMode(null)}
          engine={session.rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
          pageCount={activeTab.pages}
          currentPage={viewState.page}
          signed={activeTab.signed}
          fileName={activeTab.name}
          onChanged={(changed) => scheduler?.noteRevisions(changed?.revisions ?? {})}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <WatermarkDialog
          isOpen={watermarkOpen}
          onClose={() => setWatermarkOpen(false)}
          engine={session.rpc}
          handle={session.handle}
          startWorker={jobs.acquire}
          pageCount={activeTab.pages}
          currentPage={viewState.page}
          signed={activeTab.signed}
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
          signed={activeTab?.signed ?? false}
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
        engine={engine}
      />
      {documentShown && session !== null ? (
        <PropertiesDialog
          isOpen={propertiesOpen}
          onClose={() => setPropertiesOpen(false)}
          rpc={session.rpc}
          handle={session.handle}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <EncryptDialog
          isOpen={encryptOpen}
          onClose={() => setEncryptOpen(false)}
          rpc={session.rpc}
          handle={session.handle}
        />
      ) : null}
      {documentShown && session !== null && activeTab !== undefined ? (
        <RemoveSecurityDialog
          isOpen={removeSecurityOpen}
          onClose={() => setRemoveSecurityOpen(false)}
          rpc={session.rpc}
          handle={session.handle}
          name={activeTab.name}
        />
      ) : null}
      <SignedWarningDialog
        isOpen={signedEditAsk !== null}
        onAccept={() => {
          if (signedEditAsk !== null) acceptSignedEdit(signedEditAsk.tabId, signedEditAsk.tool);
          setSignedEditAsk(null);
        }}
        onCancel={() => {
          // Cancel leaves the Image tool off, so the file picked for it is dropped too.
          if (signedEditAsk?.tool === 'image') dropPendingImage(signedEditAsk.tabId);
          setSignedEditAsk(null);
        }}
      />
      <CommandPalette registry={REGISTRY} state={state} handlers={handlers} />
      <OpenInput inputRef={docs.inputRef} onFiles={docs.openFiles} />
      <div className={documentShown ? 'app-main app-main--document' : 'app-main'}>
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
            onAbout={() => setAboutOpen(true)}
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
            stampLibrary={stampLibrary ?? undefined}
            onViewChange={onViewChange}
            onEditImageChange={onEditImageChange}
            onCommentSelectionChange={onCommentSelectionChange}
            startWorker={jobs.acquire}
            tool={viewTool}
            tabId={activeId}
            onToolChange={(tool, tabId) => {
              // A shape add names the tab it drew on; the other resets are for the tab shown now.
              const target = tabId ?? activeId;
              if (target !== null) setViewTool(target, tool);
            }}
            onCropBoxEnd={crop.boxEnded}
            onCommentToolChange={setCommentToolState}
            onLinkGoTo={onLinkGoTo}
            searchMarks={
              searchMarks !== null && searchMarks.tabId === activeId ? searchMarks.marks : undefined
            }
          />
        ) : null}
        {documentShown && session !== null && scheduler !== null ? (
          <TranslateFlow
            key={activeId ?? undefined}
            ref={translateFlow}
            getView={getView}
            loadInfo={loadTranslationInfo}
            translate={translateCall}
            rpc={session.rpc}
            handle={session.handle}
            scheduler={scheduler}
          />
        ) : null}
      </div>
    </AppFrame>
  );
}
