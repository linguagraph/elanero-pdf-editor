// The document view (W5.1a, W1.4 sections 1, 2, 5, 6 and 8): the pages of one open document,
// stacked vertically at the zoom level, each with a placeholder at its size. Only the pages near the
// viewport are mounted; the visible ones are rendered through render.page, queued and cached as
// W1.4 describes. No annotations, text layer or tiles here (W5.1b and later).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { readPreferences, writePreferences } from '../prefs/store';
import {
  computeColumn,
  computeSpreads,
  currentPageIndex,
  distanceToCentre,
  isInViewport,
  type PageSizePt,
  visibleRange,
} from './layout';
import { PageCache, pageCacheKey } from './pageCache';
import { type QueueEntry, RenderQueue, requestKey } from './renderQueue';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, scaleMilli, stepZoom } from './zoom';
import { anchoredScroll, isZoomWheel, takeWheelSteps, wheelDeltaPixels } from './wheel';
import './documentView.css';

// How many times a page's render is asked for before it is shown as failed. A render that keeps
// failing would otherwise be requested again on every tick, without end.
export const MAX_RENDER_ATTEMPTS = 3;

// The page layouts the toolbar offers: the continuous single column, or two-page spreads.
type ViewLayout = 'continuous' | 'twoPage';

// What the view reports to its host for the status bar: the page at the middle of the viewport
// (one-based) and the zoom. In two-page mode the pages of a spread share their centre line, so the
// page reported is the left one of the spread at the middle of the viewport.
export interface DocumentViewState {
  readonly page: number;
  readonly zoom: number;
}

export interface DocumentViewProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // Called when the page or the zoom changes, and once when the view mounts. Give it a stable
  // function (a state setter, for one) so the view does not report again on each render.
  readonly onViewChange?: (state: DocumentViewState) => void;
}

interface CachedDraw {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
}

// The viewport height, or the window's when the element has no layout yet (jsdom, first paint).
function viewportHeightOf(element: HTMLElement | null): number {
  return element?.clientHeight || window.innerHeight;
}

// Puts the pixels on the canvas at their device size. The canvas keeps its CSS size from the
// layout, so the device pixels are scaled into the page box.
function drawPixels(canvas: HTMLCanvasElement, cached: CachedDraw): void {
  const context = canvas.getContext('2d');
  if (context === null) return;
  canvas.width = cached.width;
  canvas.height = cached.height;
  const image = context.createImageData(cached.width, cached.height);
  image.data.set(new Uint8ClampedArray(cached.pixels));
  context.putImageData(image, 0, 0);
  canvas.dataset.drawn = 'true';
}

// One page's sharp layer. It draws from the cache once the pixels are there; the placeholder
// beneath it shows until then.
function PageCanvas({
  cache,
  cacheKey,
  version,
}: {
  cache: PageCache;
  cacheKey: string;
  version: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const cached = cache.get(cacheKey);
    if (canvas !== null && cached !== undefined) drawPixels(canvas, cached);
  }, [cache, cacheKey, version]);
  return <canvas ref={ref} className="doc-page-canvas" />;
}

export function DocumentView({ rpc, handle, onViewChange }: DocumentViewProps) {
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
  // Bumped whenever the cache or a page revision changes; the render queue is re-planned then.
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  // Failed attempts per page key (page, revision and scale). A key that reaches the cap is shown as
  // failed and not requested again; a changed revision or scale is a new key, so it is asked for.
  const attempts = useRef(new Map<string, number>());
  const [cache] = useState(() => new PageCache());
  const [queue] = useState(() => new RenderQueue());
  const scrollRef = useRef<HTMLDivElement>(null);
  // The revision each page last reported; a page the worker changed is asked for at the new one.
  const [revisions, setRevisions] = useState<ReadonlyMap<number, number>>(() => new Map());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  // Plans the queue from what is on screen now, then sends as many requests as the limit allows.
  // Replies bump the tick, which runs this again, so the queue keeps moving until it is empty.
  useEffect(() => {
    if (sizes === null) return;
    const entries: QueueEntry[] = [];
    for (let index = range.first; index < range.end; index += 1) {
      const box = layout.boxes[index];
      if (box === undefined) continue;
      const revision = revisions.get(index) ?? 0;
      const key = pageCacheKey({ handle, page: index, revision, scaleMilli: scale, rotation: 0 });
      if (cache.has(key) || failed.has(key)) continue;
      entries.push({
        request: { page: index, revision, scaleMilli: scale, rotation: 0 },
        visible: isInViewport(box, scroll.top, scroll.height),
        distance: distanceToCentre(box, scroll.top, scroll.height),
      });
    }
    queue.plan(entries);
    for (let next = queue.next(); next !== null; next = queue.next()) {
      const request = next;
      const requestId = requestKey(request);
      const cacheKey = pageCacheKey({
        handle,
        page: request.page,
        revision: request.revision,
        scaleMilli: request.scaleMilli,
        rotation: request.rotation,
      });
      rpc
        .call('render.page', {
          handle,
          page: request.page,
          revision: request.revision,
          scale_milli: request.scaleMilli,
          rotation: request.rotation,
          annotations: false,
        })
        .then(
          (reply) => {
            queue.finish(requestId);
            if (!mounted.current) return;
            if (reply.revision === request.revision) {
              cache.set(cacheKey, {
                width: reply.width,
                height: reply.height,
                pixels: reply.pixels,
              });
            } else {
              // The page changed since the caller last saw it. The reply carries no pixels, so the
              // page is asked for again at the revision the worker reported.
              setRevisions((previous) => new Map(previous).set(request.page, reply.revision));
            }
            setTick((value) => value + 1);
          },
          () => {
            queue.finish(requestId);
            if (!mounted.current) return;
            const count = (attempts.current.get(cacheKey) ?? 0) + 1;
            attempts.current.set(cacheKey, count);
            // Below the cap the plan asks again; at the cap the page stays failed.
            if (count >= MAX_RENDER_ATTEMPTS) {
              setFailed((previous) => new Set(previous).add(cacheKey));
            }
            setTick((value) => value + 1);
          },
        );
    }
    // The plan depends on what is on screen and the scale; the cache and queue are stable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sizes,
    layout,
    range.first,
    range.end,
    scroll.top,
    scroll.height,
    scale,
    rpc,
    handle,
    tick,
    revisions,
    failed,
  ]);

  if (loadFailed) {
    return (
      <p role="alert" className="doc-view-status">
        {t('view.loadFailed')}
      </p>
    );
  }
  const total = layout.boxes.length;
  const percent = Math.round(zoom * 100);

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
              const revision = revisions.get(box.index) ?? 0;
              const cacheKey = pageCacheKey({
                handle,
                page: box.index,
                revision,
                scaleMilli: scale,
                rotation: 0,
              });
              return (
                <div
                  key={box.index}
                  className="doc-page"
                  role="group"
                  aria-label={t('view.pageNumber', { page: box.index + 1, total })}
                  style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
                >
                  <div className="doc-page-placeholder" />
                  <PageCanvas cache={cache} cacheKey={cacheKey} version={tick} />
                  {failed.has(cacheKey) ? (
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
