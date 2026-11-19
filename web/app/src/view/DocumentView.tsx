// The document view (W5.1a, W1.4 sections 1, 2, 5, 6 and 8): the pages of one open document,
// stacked vertically at the zoom level, each with a placeholder at its size. Only the pages near the
// viewport are mounted; the visible ones are rendered through render.page, queued and cached by the
// render scheduler, which the thumbnails panel of the same tab shares. Each page also gets its text
// layer (W5.4) and the search highlights. Pages above 4 MP are drawn as tiles (W5.1b, tiles.ts);
// no annotations here.
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { readPreferences, writePreferences } from '../prefs/store';
import {
  computeColumn,
  computeSpreads,
  currentPageIndex,
  type PageSizePt,
  scrollTopForPage,
  scrollTopForSpread,
  visibleRange,
} from './layout';
import { PageMarks } from '../search/PageMarks';
import { marksOnPage, type SearchMarks } from '../search/search';
import { PageTextLayer } from '../text/PageTextLayer';
import { CommentLayer } from '../comments/CommentLayer';
import { CommentToolbar } from '../comments/CommentToolbar';
import type { PageRect } from '../comments/coordinates';
import { placeComment } from '../comments/placement';
import type { CommentToolId } from '../comments/tools';
import { TextLayerCache } from '../text/textLayerCache';
import { CachedCanvas } from './pixels';
import { RenderScheduler } from './renderScheduler';
import { planPageRenders, tileRect, tilesInViewport } from './tiles';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, scaleMilli, stepZoom } from './zoom';
import { anchoredScroll, isZoomWheel, takeWheelSteps, wheelDeltaPixels } from './wheel';
import './documentView.css';

export { MAX_RENDER_ATTEMPTS } from './renderScheduler';

// The page layouts the toolbar offers: the continuous single column, or two-page spreads.
type ViewLayout = 'continuous' | 'twoPage';

// What the parent can ask the view to do. Scrolling is the only action for now.
export interface DocumentViewHandle {
  // Scrolls so the page's top edge is at the top of the viewport. Out-of-range indexes do nothing.
  scrollToPage(index: number): void;
}

// What the view reports to its host for the status bar: the page at the middle of the viewport
// (one-based) and the zoom.
export interface DocumentViewState {
  readonly page: number;
  readonly zoom: number;
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
}

// The viewport height, or the window's when the element has no layout yet (jsdom, first paint).
function viewportHeightOf(element: HTMLElement | null): number {
  return element?.clientHeight || window.innerHeight;
}

export function DocumentView({
  rpc,
  handle,
  scheduler: shared,
  ref,
  onViewChange,
  searchMarks,
}: DocumentViewProps) {
  const [sizes, setSizes] = useState<readonly PageSizePt[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [viewLayout, setViewLayout] = useState<ViewLayout>('continuous');
  const [firstAlone, setFirstAlone] = useState(false);
  // Night reading is a saved preference: read once here, written when the toggle changes.
  const [night, setNight] = useState(() => readPreferences().nightReading);
  // The zoom as the latest wheel event left it, so a burst of events builds on each other.
  const zoomRef = useRef(zoom);
  const wheelPending = useRef(0);
  // Where the content point under the pointer must be scrolled to once the new zoom is laid out.
  const pendingAnchor = useRef<{ left: number; top: number } | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  // Bumped whenever the scheduler finished a render; the queue is re-planned then.
  const [tick, setTick] = useState(0);
  const [ownScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const scheduler = shared ?? ownScheduler;
  const scrollRef = useRef<HTMLDivElement>(null);
  // The comment tool on, if any (W7.1a): a click or drag on a page then places a comment.
  const [commentTool, setCommentTool] = useState<CommentToolId | null>(null);
  // The text layers of this document, one per page and revision (W5.4).
  const textLayers = useMemo(() => new TextLayerCache(rpc, handle), [rpc, handle]);

  useEffect(() => {
    let active = true;
    rpc
      .call('session.pages', { handle })
      .then((reply) => {
        if (active) setSizes(reply.pages);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [rpc, handle]);

  useEffect(() => scheduler.subscribe(() => setTick((value) => value + 1)), [scheduler]);

  const layout = useMemo(
    () =>
      viewLayout === 'twoPage'
        ? computeSpreads(sizes ?? [], zoom, firstAlone)
        : computeColumn(sizes ?? [], zoom),
    [sizes, zoom, viewLayout, firstAlone],
  );

  // Reads the scroll position and the viewport height into state: on scroll, on resize and once
  // the pages are known.
  const measure = () => {
    const element = scrollRef.current;
    setScroll({ top: element?.scrollTop ?? 0, height: viewportHeightOf(element) });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [sizes]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(index: number) {
        const element = scrollRef.current;
        const top =
          viewLayout === 'twoPage'
            ? scrollTopForSpread(layout.boxes, index, zoom, firstAlone)
            : scrollTopForPage(layout.boxes, index, zoom);
        if (element === null || top === null) return;
        element.scrollTop = top;
        setScroll({ top, height: viewportHeightOf(element) });
      },
    }),
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
      setZoom(to);
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
    setScroll({ top: element.scrollTop, height: viewportHeightOf(element) });
  }, [zoom]);

  const devicePixelRatio = window.devicePixelRatio || 1;
  const scale = scaleMilli(zoom, devicePixelRatio);
  const range = visibleRange(layout.boxes, scroll.top, scroll.height);
  const currentPage = currentPageIndex(layout.boxes, scroll.top, scroll.height) + 1;
  useEffect(() => {
    onViewChange?.({ page: currentPage, zoom });
  }, [currentPage, zoom, onViewChange]);

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

  if (loadFailed) {
    return (
      <p role="alert" className="doc-view-status">
        {t('view.loadFailed')}
      </p>
    );
  }
  const total = layout.boxes.length;
  const percent = Math.round(zoom * 100);

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
      className={night ? 'doc-view doc-view--night' : 'doc-view'}
      aria-label={t('view.label')}
    >
      <div className="doc-view-toolbar" role="toolbar" aria-label={t('view.zoomLabel')}>
        <button
          type="button"
          onClick={() => setZoom(stepZoom(zoom, -1))}
          disabled={zoom <= MIN_ZOOM}
        >
          {t('view.zoomOut')}
        </button>
        <span className="doc-view-zoom" aria-live="polite">
          {t('view.zoomPercent', { percent })}
        </span>
        <button
          type="button"
          onClick={() => setZoom(stepZoom(zoom, 1))}
          disabled={zoom >= MAX_ZOOM}
        >
          {t('view.zoomIn')}
        </button>
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
        <CommentToolbar tool={commentTool} onChoose={setCommentTool} />
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
    </section>
  );
}
