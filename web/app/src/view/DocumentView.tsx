// The document view (W5.1a, W1.4 sections 1, 2, 5, 6 and 8): the pages of one open document,
// stacked vertically at the zoom level, each with a placeholder at its size. Only the pages near the
// viewport are mounted; the visible ones are rendered through render.page, queued and cached by the
// render scheduler, which the thumbnails panel of the same tab shares. No annotations, text layer or
// tiles here (W5.1b and later).
import { type Ref, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import {
  computeColumn,
  distanceToCentre,
  isInViewport,
  type PageSizePt,
  scrollTopForPage,
  visibleRange,
} from './layout';
import { pageCacheKey } from './pageCache';
import { CachedCanvas } from './pixels';
import { type PlannedRender, RenderScheduler } from './renderScheduler';
import { DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM, scaleMilli, stepZoom } from './zoom';
import './documentView.css';

export { MAX_RENDER_ATTEMPTS } from './renderScheduler';

// What the parent can ask the view to do. Scrolling is the only action for now.
export interface DocumentViewHandle {
  // Scrolls so the page's top edge is at the top of the viewport. Out-of-range indexes do nothing.
  scrollToPage(index: number): void;
}

export interface DocumentViewProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab's scheduler, shared with the thumbnails panel. When absent the view makes its own.
  readonly scheduler?: RenderScheduler;
  readonly ref?: Ref<DocumentViewHandle>;
}

// The viewport height, or the window's when the element has no layout yet (jsdom, first paint).
function viewportHeightOf(element: HTMLElement | null): number {
  return element?.clientHeight || window.innerHeight;
}

export function DocumentView({ rpc, handle, scheduler: shared, ref }: DocumentViewProps) {
  const [sizes, setSizes] = useState<readonly PageSizePt[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  // Bumped whenever the scheduler finished a render; the queue is re-planned then.
  const [tick, setTick] = useState(0);
  const [ownScheduler] = useState(() => new RenderScheduler(rpc, handle));
  const scheduler = shared ?? ownScheduler;
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const layout = useMemo(() => computeColumn(sizes ?? [], zoom), [sizes, zoom]);

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
        const top = scrollTopForPage(layout.boxes, index, zoom);
        if (element === null || top === null) return;
        element.scrollTop = top;
        setScroll({ top, height: viewportHeightOf(element) });
      },
    }),
    [layout, zoom],
  );

  const devicePixelRatio = window.devicePixelRatio || 1;
  const scale = scaleMilli(zoom, devicePixelRatio);
  const range = visibleRange(layout.boxes, scroll.top, scroll.height);

  // Plans the page renders from what is on screen now. Renders finishing bump the tick, which runs
  // this again, so the queue keeps moving until it is empty.
  useEffect(() => {
    if (sizes === null) return;
    const planned: PlannedRender[] = [];
    for (let index = range.first; index < range.end; index += 1) {
      const box = layout.boxes[index];
      if (box === undefined) continue;
      planned.push({
        page: index,
        scaleMilli: scale,
        visible: isInViewport(box, scroll.top, scroll.height),
        distance: distanceToCentre(box, scroll.top, scroll.height),
      });
    }
    scheduler.plan('page', planned);
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

  return (
    <section className="doc-view" aria-label={t('view.label')}>
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
              const cacheKey = pageCacheKey({
                handle,
                page: box.index,
                revision: scheduler.revisionOf(box.index),
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
                  <CachedCanvas
                    cache={scheduler.cache}
                    cacheKey={cacheKey}
                    version={tick}
                    className="doc-page-canvas"
                  />
                  {scheduler.isFailed(cacheKey) ? (
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
