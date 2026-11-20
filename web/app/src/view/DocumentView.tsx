// The document view (W5.1a, W1.4 sections 1, 2, 5, 6 and 8): the pages of one open document,
// stacked vertically at the zoom level, each with a placeholder at its size. Only the pages near the
// viewport are mounted; the visible ones are rendered through render.page, queued and cached by the
// render scheduler, which the thumbnails panel of the same tab shares. Each page also gets its text
// layer (W5.4) and the search highlights. Pages above 4 MP are drawn as tiles (W5.1b, tiles.ts);
// no annotations here.
import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import {
  onPreferencesChanged,
  readPreferences,
  writePreferences,
  type PageLayoutChoice,
  type ZoomChoice,
} from '../prefs/store';
import {
  computeColumn,
  computeSpreads,
  currentPageIndex,
  fitPageZoom,
  fitWidthZoom,
  largestPage,
  type FitMode,
  type PageSizePt,
  scrollTopForPage,
  scrollTopForSpread,
  type ViewLayout,
  visibleRange,
} from './layout';
import { PageMarks } from '../search/PageMarks';
import { marksOnPage, type SearchMarks } from '../search/search';
import { PageTextLayer } from '../text/PageTextLayer';
import { useHandPan } from './useHandPan';
import type { ViewTool } from './viewTool';
import { CropLayer } from '../crop/CropLayer';
import { marginsFromBox, type DrawnCrop } from '../crop/cropChoice';
import { CommentLayer } from '../comments/CommentLayer';
import { CommentToolbar } from '../comments/CommentToolbar';
import type { PageRect } from '../comments/coordinates';
import { placeComment } from '../comments/placement';
import type { CommentToolId } from '../comments/tools';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { RedactionController } from '../redaction/controller';
import { RedactLayer, SelectedMarkOutlines } from '../redaction/RedactLayer';
import { RedactionBar } from '../redaction/RedactionBar';
import { selectedRectsOn } from '../redaction/controller';
import { useRedaction } from '../redaction/useRedaction';
import type { TextLine } from '../text/textLayer';
import { TextLayerCache } from '../text/textLayerCache';
import { CachedCanvas } from './pixels';
import { RenderScheduler } from './renderScheduler';
import { planPageRenders, tileRect, tilesInViewport } from './tiles';
import { CanvasPill } from './CanvasPill';
import { DEFAULT_ZOOM, clampZoom, scaleMilli, stepZoom } from './zoom';
import type { ZoomRequest } from './zoomBox';
import { anchoredScroll, isZoomWheel, takeWheelSteps, wheelDeltaPixels } from './wheel';
import './documentView.css';

export { MAX_RENDER_ATTEMPTS } from './renderScheduler';

// The page layouts the toolbar offers: the continuous single column, or two-page spreads.

// What the parent can ask the view to do: the ribbon's View and Home commands and the shortcuts reach
// the view through here (W4.2a S6), as the canvas pill does from inside.
export interface DocumentViewHandle {
  // Scrolls so the page's top edge is at the top of the viewport. Out-of-range indexes do nothing.
  scrollToPage(index: number): void;
  // A zoom request (a fit mode or a percentage), or one step of the zoom in either direction.
  zoom(request: ZoomRequest | { readonly step: -1 | 1 }): void;
  // Moves to the next or the previous page, clamped to the document.
  stepPage(direction: -1 | 1): void;
  // Focuses the canvas pill's page field and selects its text (the status bar's Go to Page, W4.3b).
  focusPageField(): void;
  // The text lines of a page as they are shown, or undefined until they arrive (W4.12: the selection maps them).
  cachedLines(page: number): readonly TextLine[] | undefined;
}

// What the view reports to its host for the status bar: the page at the middle of the viewport
// (one-based), the zoom, and the document's page labels (one per page; empty when it has none).
export interface DocumentViewState {
  readonly page: number;
  readonly zoom: number;
  // The page layout the reader chose (single column or two-page spreads).
  readonly layout: ViewLayout;
  readonly labels: readonly string[];
}

export interface DocumentViewProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab's scheduler, shared with the thumbnails panel. When absent the view makes its own.
  readonly scheduler?: RenderScheduler;
  readonly ref?: Ref<DocumentViewHandle>;
  // Called when the page or the zoom changes, and once when the view mounts. Give it a stable
  // function (a state setter, for one) so the view does not report again on each render.
  readonly onViewChange?: (state: DocumentViewState) => void;
  // The search hits to draw on the pages, and the selected one (W5.4).
  readonly searchMarks?: SearchMarks;
  // Starts the job worker for the redaction apply (W7.4). Tests leave it out; applying then fails.
  readonly startWorker?: () => ActionJobWorker;
  // The document's redaction controller, made by the app per session (W7.4b) so the toolbar and the
  // redactions panel share it. The view makes its own when absent.
  readonly redaction?: RedactionController;
  // The view tool (W4.10): Hand pans with a drag. The app keeps it per tab; Select when absent.
  readonly tool?: ViewTool;
  // Called when the view itself asks for another tool: a comment or mark tool chosen here sets it
  // back to Select, so the two never read as on together.
  readonly onToolChange?: (tool: ViewTool) => void;
  // The crop box tool (W4.11 S5) reports the box it drew, as margins on its page (1-based), or null
  // when Esc ends the tool with no box. The app ends the tool and reopens the crop dialog.
  readonly onCropBoxEnd?: (drawn: DrawnCrop | null) => void;
}

// The job worker is missing: the apply reports its failure, as any other failed job does.
function noJobWorker(): ActionJobWorker {
  throw new Error('the job worker is not available');
}

// The viewport size, or the window's when the element has no layout yet (jsdom, first paint).
function viewportOf(element: HTMLElement | null): { top: number; height: number; width: number } {
  return {
    top: element?.scrollTop ?? 0,
    height: element?.clientHeight || window.innerHeight,
    width: element?.clientWidth || window.innerWidth,
  };
}

// The fit mode a saved default zoom asks for; Actual size is no fit (the zoom is 100 %).
function fitForChoice(choice: ZoomChoice): FitMode | null {
  if (choice === 'fitWidth') return 'width';
  if (choice === 'fitPage') return 'page';
  return null;
}

// The saved default page layout as the view's two settings. Two pages with the first page alone is
// the cover layout (W4.5 S2); the single-page layout (W5.1a) is not offered yet.
function layoutForChoice(choice: PageLayoutChoice): { layout: ViewLayout; firstAlone: boolean } {
  if (choice === 'twoPage') return { layout: 'twoPage', firstAlone: false };
  if (choice === 'twoPageCover') return { layout: 'twoPage', firstAlone: true };
  return { layout: 'continuous', firstAlone: false };
}

export function DocumentView({
  rpc,
  handle,
  scheduler: shared,
  ref,
  onViewChange,
  searchMarks,
  startWorker,
  redaction,
  tool = 'select',
  onToolChange,
  onCropBoxEnd,
}: DocumentViewProps) {
  const [sizes, setSizes] = useState<readonly PageSizePt[] | null>(null);
  // The page labels, from the same session.pages reply as the sizes (W5.3).
  const [labels, setLabels] = useState<readonly string[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  // The zoom the reader picked by steps, the wheel or the presets; used when no fit mode is on.
  const [manualZoom, setManualZoom] = useState(DEFAULT_ZOOM);
  // The fit mode, if any. The saved default zoom starts it when the document opens (W5.1e).
  const [fit, setFit] = useState<FitMode | null>(() => fitForChoice(readPreferences().defaultZoom));
  // The default the view last applied, so a save that leaves it unchanged does not reset the zoom.
  const appliedChoice = useRef<ZoomChoice>(readPreferences().defaultZoom);
  // The default page layout (W4.5 S2) starts the view, and a changed default applies the same way
  // the zoom default does; the reader's own choice is kept until the default changes.
  const [startLayout] = useState<PageLayoutChoice>(() => readPreferences().pageLayout);
  const appliedLayout = useRef<PageLayoutChoice>(startLayout);
  const [viewLayout, setViewLayout] = useState<ViewLayout>(
    () => layoutForChoice(startLayout).layout,
  );
  const [firstAlone, setFirstAlone] = useState(() => layoutForChoice(startLayout).firstAlone);
  // Night reading is a saved preference: read once here, written when the toggle changes.
  const [night, setNight] = useState(() => readPreferences().nightReading);
  // The zoom as the latest wheel event left it, so a burst of events builds on each other.
  const zoomRef = useRef(manualZoom);
  // The canvas pill's page field, which focusPageField reaches; set while the pill is mounted.
  const pageFieldRef = useRef<HTMLInputElement>(null);
  const wheelPending = useRef(0);
  // Where the content point under the pointer must be scrolled to once the new zoom is laid out.
  const pendingAnchor = useRef<{ left: number; top: number } | null>(null);
  // The page at the top of the view, kept up to date, and the page a changed default layout must
  // keep in view once the new layout is laid out (W4.5 S2: the layout change must not lose place).
  const topPage = useRef(0);
  const pendingPage = useRef<number | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0, width: 0 });
  // Bumped whenever the scheduler finished a render; the queue is re-planned then.
  const [tick, setTick] = useState(0);
  const [ownScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const scheduler = shared ?? ownScheduler;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The comment tool on, if any (W7.1a): a click or drag on a page then places a comment.
  const [commentTool, setCommentTool] = useState<CommentToolId | null>(null);
  // The redaction tools (W7.4). The mark tool and a comment tool are not on together.
  const redactionTools = useRedaction({
    rpc,
    handle,
    scheduler,
    startWorker: startWorker ?? noJobWorker,
    controller: redaction,
  });
  const pan = useHandPan(tool === 'hand');
  // The Hand and crop box tools and the comment or mark tools are not on together: choosing one of
  // the view tools turns them off (the last tool chosen wins, as the desktop has one tool per
  // document). The comment tool is reset while rendering, when the tool prop changes, so no effect
  // sets state.
  const [seenTool, setSeenTool] = useState(tool);
  if (seenTool !== tool) {
    setSeenTool(tool);
    if (tool !== 'select') setCommentTool(null);
  }
  useEffect(() => {
    if (tool === 'select') return;
    redactionTools.controller.setActive(false);
  }, [tool, redactionTools.controller]);
  // Esc ends the crop box tool with no box, from anywhere in the page (the pointer may have left the
  // view's focus), and the dialog reopens unchanged. An Esc another part already handled, or one
  // meant for an open dialog (which owns Escape, as in useDismissablePanels), is left alone.
  useEffect(() => {
    if (tool !== 'cropBox') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('.overlay-backdrop')) return;
      onCropBoxEnd?.(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tool, onCropBoxEnd]);
  // The text layers of this document, one per page and revision (W5.4).
  const textLayers = useMemo(() => new TextLayerCache(rpc, handle), [rpc, handle]);

  useEffect(() => {
    let active = true;
    rpc
      .call('session.pages', { handle })
      .then((reply) => {
        if (active) {
          setSizes(reply.pages);
          setLabels(reply.labels);
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle]);

  useEffect(() => scheduler.subscribe(() => setTick((value) => value + 1)), [scheduler]);

  // The zoom in effect: the fitted one while a fit mode is on (it follows the viewport size, so a
  // resize refits), else the manual zoom. The fit is the widest and tallest page, so every page fits.
  const columns = viewLayout === 'twoPage' ? 2 : 1;
  const fitted =
    fit === null
      ? null
      : fit === 'width'
        ? fitWidthZoom(largestPage(sizes ?? []).width, scroll.width, columns)
        : fitPageZoom(
            largestPage(sizes ?? []).width,
            largestPage(sizes ?? []).height,
            scroll.width,
            scroll.height,
            columns,
          );
  const zoom = fitted ?? manualZoom;

  // Leaves any fit mode for a manual zoom: the steps, the wheel and the presets all do this.
  const zoomTo = (value: number) => {
    setFit(null);
    setManualZoom(value);
  };

  const layout = useMemo(
    () =>
      viewLayout === 'twoPage'
        ? computeSpreads(sizes ?? [], zoom, firstAlone)
        : computeColumn(sizes ?? [], zoom),
    [sizes, zoom, viewLayout, firstAlone],
  );

  // Reads the scroll position and the viewport size into state: on scroll, on resize (the window's,
  // and the element's own, which moves when the layout around it does) and once the pages are known.
  // A width or height change under 1 px is ignored: a scrollbar appearing or a rounding step must not
  // make the fitted zoom flip back and forth between two values.
  const measure = () => {
    const next = viewportOf(scrollRef.current);
    setScroll((prev) => ({
      top: next.top,
      height: Math.abs(next.height - prev.height) >= 1 ? next.height : prev.height,
      width: Math.abs(next.width - prev.width) >= 1 ? next.width : prev.width,
    }));
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    if (observer !== null && scrollRef.current !== null) observer.observe(scrollRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [sizes]);

  // The saved default zoom, applied when the user saves a different one while the document is open.
  // Saving other preferences leaves the zoom alone.
  useEffect(
    () =>
      onPreferencesChanged(() => {
        const choice = readPreferences().defaultZoom;
        if (choice === appliedChoice.current) return;
        appliedChoice.current = choice;
        setFit(fitForChoice(choice));
        if (choice === 'actual') setManualZoom(DEFAULT_ZOOM);
      }),
    [],
  );

  // The saved default page layout, applied the same way: only a changed choice moves the view.
  useEffect(
    () =>
      onPreferencesChanged(() => {
        const choice = readPreferences().pageLayout;
        if (choice === appliedLayout.current) return;
        appliedLayout.current = choice;
        const next = layoutForChoice(choice);
        pendingPage.current = topPage.current;
        setViewLayout(next.layout);
        setFirstAlone(next.firstAlone);
      }),
    [],
  );

  // Scrolls so the page's top edge is at the top of the viewport; shared by the handle and the pill.
  const scrollToPage = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      const top =
        viewLayout === 'twoPage'
          ? scrollTopForSpread(layout.boxes, index, zoom, firstAlone)
          : scrollTopForPage(layout.boxes, index, zoom);
      if (element === null || top === null) return;
      element.scrollTop = top;
      setScroll(viewportOf(element));
    },
    [layout, zoom, viewLayout, firstAlone],
  );

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Ctrl+wheel (Cmd on macOS) steps the zoom through the desktop's steps and keeps the point under
  // the pointer in place. The listener is native and not passive, so preventDefault stops the
  // browser from zooming the whole page.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || sizes === null) return;
    const onWheel = (event: WheelEvent) => {
      if (!isZoomWheel(event)) return;
      event.preventDefault();
      const step = takeWheelSteps(wheelPending.current, wheelDeltaPixels(event));
      wheelPending.current = step.pending;
      if (step.direction === null) return;
      const from = zoomRef.current;
      const to = stepZoom(from, step.direction);
      if (to === from) return;
      const rect = element.getBoundingClientRect();
      pendingAnchor.current = anchoredScroll({
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        pointerX: event.clientX - rect.left,
        pointerY: event.clientY - rect.top,
        fromZoom: from,
        toZoom: to,
      });
      zoomRef.current = to;
      setFit(null);
      setManualZoom(to);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [sizes]);

  // Applies the anchor after the new zoom is in the DOM, so the scroll range already has the new size.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const element = scrollRef.current;
    if (anchor === null || element === null) return;
    pendingAnchor.current = null;
    element.scrollLeft = anchor.left;
    element.scrollTop = anchor.top;
    setScroll(viewportOf(element));
  }, [zoom]);

  // Keeps the page that was at the top in view when the default layout changed: the new layout is
  // laid out here, so the page's new top is known. Spreads are scrolled to by their row.
  useLayoutEffect(() => {
    const index = pendingPage.current;
    const element = scrollRef.current;
    if (index === null || element === null) return;
    pendingPage.current = null;
    const top =
      viewLayout === 'twoPage'
        ? scrollTopForSpread(layout.boxes, index, zoom, firstAlone)
        : scrollTopForPage(layout.boxes, index, zoom);
    if (top === null) return;
    element.scrollTop = top;
    setScroll(viewportOf(element));
  }, [viewLayout, firstAlone, layout, zoom]);

  const devicePixelRatio = window.devicePixelRatio || 1;
  const scale = scaleMilli(zoom, devicePixelRatio);
  const range = visibleRange(layout.boxes, scroll.top, scroll.height);
  const currentPage = currentPageIndex(layout.boxes, scroll.top, scroll.height) + 1;
  useEffect(() => {
    topPage.current = currentPage - 1;
  }, [currentPage]);
  useEffect(() => {
    onViewChange?.({ page: currentPage, zoom, layout: viewLayout, labels });
  }, [currentPage, zoom, viewLayout, labels, onViewChange]);

  // Plans the page renders from what is on screen now: the visible pages first, then the pages
  // just outside the viewport (prefetch, which the scheduler sends after the visible ones). A page
  // above 4 MP is planned as its tiles. Renders finishing bump the tick, which runs this again, so
  // the queue keeps moving until it is empty.
  useEffect(() => {
    if (sizes === null) return;
    scheduler.plan(
      'page',
      planPageRenders({
        boxes: layout.boxes,
        sizes,
        first: range.first,
        end: range.end,
        scrollTop: scroll.top,
        viewportHeight: scroll.height,
        scaleMilli: scale,
      }),
    );
    // The plan depends on what is on screen and the scale; the scheduler is stable state.
  }, [sizes, layout, range.first, range.end, scroll.top, scroll.height, scale, scheduler, tick]);

  const total = layout.boxes.length;

  // The canvas pill's and the handle's zoom request: a fit mode or a manual zoom. Only setters are
  // used, so the callback is stable.
  const applyZoom = useCallback((request: ZoomRequest) => {
    if ('fit' in request) {
      setFit(request.fit);
    } else {
      setFit(null);
      setManualZoom(clampZoom(request.zoom));
    }
  }, []);
  // The next or previous page, clamped to the document (the pill's steps and the handle's).
  const stepPage = useCallback(
    (direction: -1 | 1) => {
      scrollToPage(Math.min(total - 1, Math.max(0, currentPage - 1 + direction)));
    },
    [scrollToPage, total, currentPage],
  );
  // Hooks stay above the load-failed return, so the handle is set before it.
  useImperativeHandle(
    ref,
    () => ({
      scrollToPage,
      zoom: (request) =>
        applyZoom('step' in request ? { zoom: stepZoom(zoom, request.step) } : request),
      stepPage,
      focusPageField: () => {
        pageFieldRef.current?.focus();
        pageFieldRef.current?.select();
      },
      cachedLines: (page) => textLayers.ready(page, scheduler.revisionOf(page)),
    }),
    [scrollToPage, zoom, applyZoom, stepPage, textLayers, scheduler],
  );

  if (loadFailed) {
    return (
      <p role="alert" className="doc-view-status">
        {t('view.loadFailed')}
      </p>
    );
  }

  const commentDeps = { rpc, handle, scheduler };
  const place = (page: number, rect: PageRect, text: string) => {
    if (commentTool !== null) void placeComment(commentDeps, commentTool, page, rect, text);
  };

  const chooseNight = (on: boolean) => {
    setNight(on);
    writePreferences({ ...readPreferences(), nightReading: on });
  };

  return (
    <section
      className={[
        'doc-view',
        night ? 'doc-view--night' : '',
        tool === 'hand' ? 'doc-view--hand' : '',
        tool === 'cropBox' ? 'doc-view--crop-box' : '',
        pan.panning ? 'doc-view--panning' : '',
      ]
        .filter((name) => name !== '')
        .join(' ')}
      aria-label={t('view.label')}
    >
      {tool === 'cropBox' ? <p className="crop-draw-hint">{t('crop.drawHint')}</p> : null}
      <div className="doc-view-toolbar" role="toolbar" aria-label={t('view.label')}>
        <div role="group" aria-label={t('view.layoutLabel')}>
          <button
            type="button"
            aria-pressed={viewLayout === 'continuous'}
            onClick={() => setViewLayout('continuous')}
          >
            {t('view.layoutSingle')}
          </button>
          <button
            type="button"
            aria-pressed={viewLayout === 'twoPage'}
            onClick={() => setViewLayout('twoPage')}
          >
            {t('view.layoutTwoPage')}
          </button>
        </div>
        <button
          type="button"
          aria-pressed={firstAlone}
          disabled={viewLayout !== 'twoPage'}
          onClick={() => setFirstAlone(!firstAlone)}
        >
          {t('view.coverAlone')}
        </button>
        <button type="button" aria-pressed={night} onClick={() => chooseNight(!night)}>
          {t('view.night')}
        </button>
        <CommentToolbar
          tool={commentTool}
          onChoose={(chosen) => {
            redactionTools.controller.setActive(false);
            setCommentTool(chosen);
            if (chosen !== null) onToolChange?.('select');
          }}
        />
        <RedactionBar
          state={redactionTools.state}
          onToggle={() => {
            const on = !redactionTools.state.active;
            redactionTools.controller.setActive(on);
            if (on) {
              setCommentTool(null);
              onToolChange?.('select');
            }
          }}
          onClear={() => void redactionTools.controller.clear()}
          onApply={() => void redactionTools.controller.apply(null)}
        />
      </div>
      {sizes === null ? (
        <p role="status" className="doc-view-status">
          {t('view.loading')}
        </p>
      ) : (
        <div
          ref={scrollRef}
          className="doc-view-scroll"
          tabIndex={0}
          aria-label={t('view.pages')}
          onScroll={measure}
          onPointerDown={pan.onPointerDown}
          onPointerMove={pan.onPointerMove}
          onPointerUp={pan.onPointerUp}
          onPointerCancel={pan.onPointerCancel}
          onLostPointerCapture={pan.onLostPointerCapture}
        >
          <div className="doc-view-content" style={{ width: layout.width, height: layout.height }}>
            {layout.boxes.slice(range.first, range.end).map((box) => {
              // A page above 4 MP is drawn as the tiles of its visible part; a smaller one as one image.
              const size = sizes[box.index];
              const tiled =
                size === undefined
                  ? null
                  : tilesInViewport(box, size, scale, scroll.top, scroll.height);
              const keys =
                tiled === null
                  ? [scheduler.cacheKeyOf('page', box.index, scale)]
                  : tiled.cells.map((cell) => scheduler.cacheKeyOf('page', box.index, scale, cell));
              return (
                <div
                  key={box.index}
                  data-page={box.index}
                  className="doc-page"
                  role="group"
                  aria-label={t('view.pageNumber', { page: box.index + 1, total })}
                  style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
                >
                  <div className="doc-page-placeholder" />
                  {tiled === null ? (
                    <CachedCanvas
                      cache={scheduler.cache}
                      cacheKey={keys[0] ?? ''}
                      version={tick}
                      className="doc-page-canvas"
                    />
                  ) : (
                    tiled.cells.map((cell, index) => {
                      const rect = tileRect(tiled.device, cell);
                      const percent = (value: number, of: number) => `${(value / of) * 100}%`;
                      return (
                        <CachedCanvas
                          key={`${cell.tileX}:${cell.tileY}`}
                          cache={scheduler.cache}
                          cacheKey={keys[index] ?? ''}
                          version={tick}
                          className="doc-page-canvas"
                          style={{
                            left: percent(rect.x, tiled.device.width),
                            top: percent(rect.y, tiled.device.height),
                            width: percent(rect.width, tiled.device.width),
                            height: percent(rect.height, tiled.device.height),
                          }}
                        />
                      );
                    })
                  )}
                  <PageMarks rects={marksOnPage(searchMarks, box.index, zoom)} />
                  {commentTool !== null && sizes !== null ? (
                    <CommentLayer
                      tool={commentTool}
                      zoom={zoom}
                      widthPt={sizes[box.index]?.width ?? 0}
                      heightPt={sizes[box.index]?.height ?? 0}
                      onPlace={(rect, text) => place(box.index, rect, text)}
                    />
                  ) : null}
                  <SelectedMarkOutlines
                    rects={selectedRectsOn(redactionTools.state, box.index)}
                    zoom={zoom}
                  />
                  {tool === 'cropBox' && sizes !== null ? (
                    <CropLayer
                      zoom={zoom}
                      widthPt={sizes[box.index]?.width ?? 0}
                      heightPt={sizes[box.index]?.height ?? 0}
                      onDraw={(rect) => {
                        const size = sizes[box.index];
                        if (size !== undefined)
                          onCropBoxEnd?.({
                            page: box.index + 1,
                            margins: marginsFromBox(rect, size),
                          });
                      }}
                    />
                  ) : null}
                  {redactionTools.state.active && sizes !== null ? (
                    <RedactLayer
                      zoom={zoom}
                      widthPt={sizes[box.index]?.width ?? 0}
                      heightPt={sizes[box.index]?.height ?? 0}
                      onPlace={(rect) => void redactionTools.controller.add(box.index, rect)}
                    />
                  ) : null}
                  <PageTextLayer
                    cache={textLayers}
                    page={box.index}
                    revision={scheduler.revisionOf(box.index)}
                    zoom={zoom}
                  />
                  {keys.some((key) => scheduler.isFailed(key)) ? (
                    <span className="doc-page-error">{t('view.renderFailed')}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {sizes === null ? null : (
        <CanvasPill
          page={currentPage}
          total={total}
          labels={labels}
          zoom={zoom}
          fit={fit}
          onGoTo={scrollToPage}
          onStep={stepPage}
          onZoom={applyZoom}
          onZoomStep={(direction) => zoomTo(stepZoom(zoom, direction))}
          pageFieldRef={pageFieldRef}
        />
      )}
    </section>
  );
}
