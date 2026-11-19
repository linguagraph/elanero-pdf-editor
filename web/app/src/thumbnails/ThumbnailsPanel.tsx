// The thumbnails side panel (W5.2, W1.4 section 9). One whole-page image per page at 160 CSS px
// wide, drawn through render.page on the tab's shared render scheduler at the lowest priority. Only
// the thumbnails near the panel's viewport are requested; the rest are placeholders at the page's
// shape. A click on a thumbnail asks the document view to scroll to that page.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { Panel } from '../layout/Panel';
import { isInViewport, distanceToCentre } from '../view/layout';
import { CachedCanvas } from '../view/pixels';
import { type PlannedRender, type RenderScheduler } from '../view/renderScheduler';
import {
  thumbnailBoxes,
  thumbnailScaleMilli,
  thumbnailWindow,
  type ThumbnailSize,
} from '../view/thumbnails';
import './thumbnails.css';

export interface ThumbnailsPanelProps {
  readonly rpc: PageRpc;
  readonly handle: string;
  // The tab's scheduler, shared with the document view.
  readonly scheduler: RenderScheduler;
  // Called with the page index (zero-based) when a thumbnail is chosen.
  readonly onSelect: (index: number) => void;
  readonly onClose: () => void;
}

function viewportHeightOf(element: HTMLElement | null): number {
  return element?.clientHeight || window.innerHeight;
}

function ThumbnailList({
  rpc,
  handle,
  scheduler,
  onSelect,
}: Omit<ThumbnailsPanelProps, 'onClose'>) {
  const [sizes, setSizes] = useState<readonly ThumbnailSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  // Bumped whenever the scheduler finished a render; the thumbnails are drawn and planned again.
  const [tick, setTick] = useState(0);
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

  // A dropped panel leaves no thumbnail waiting in the queue.
  useEffect(() => () => scheduler.plan('thumb', []), [scheduler]);

  const { boxes, height } = useMemo(() => thumbnailBoxes(sizes ?? []), [sizes]);

  const measure = () => {
    const element = scrollRef.current;
    setScroll({ top: element?.scrollTop ?? 0, height: viewportHeightOf(element) });
  };
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [sizes]);

  const devicePixelRatio = window.devicePixelRatio || 1;
  const range = thumbnailWindow(boxes, scroll.top, scroll.height);

  useEffect(() => {
    if (sizes === null) return;
    const planned: PlannedRender[] = [];
    for (let index = range.first; index < range.end; index += 1) {
      const box = boxes[index];
      const size = sizes[index];
      if (box === undefined || size === undefined) continue;
      planned.push({
        page: index,
        scaleMilli: thumbnailScaleMilli(size, devicePixelRatio),
        visible: isInViewport(box, scroll.top, scroll.height),
        distance: distanceToCentre(box, scroll.top, scroll.height),
      });
    }
    scheduler.plan('thumb', planned);
    // The plan depends on what is on screen; the scheduler is stable state.
  }, [
    sizes,
    boxes,
    range.first,
    range.end,
    scroll.top,
    scroll.height,
    devicePixelRatio,
    scheduler,
    tick,
  ]);

  if (loadFailed) {
    return (
      <p role="alert" className="thumbs-status">
        {t('thumbnails.loadFailed')}
      </p>
    );
  }
  if (sizes === null) {
    return (
      <p role="status" className="thumbs-status">
        {t('thumbnails.loading')}
      </p>
    );
  }
  const total = sizes.length;

  return (
    <div
      ref={scrollRef}
      className="thumbs-scroll panel-fill"
      tabIndex={0}
      aria-label={t('thumbnails.list')}
      onScroll={measure}
    >
      <div className="thumbs-content" style={{ height }}>
        {boxes.slice(range.first, range.end).map((box) => {
          const size = sizes[box.index];
          const scale = size === undefined ? 1 : thumbnailScaleMilli(size, devicePixelRatio);
          const cacheKey = scheduler.cacheKeyOf('thumb', box.index, scale);
          return (
            <button
              key={box.index}
              type="button"
              className="thumbs-item"
              aria-label={t('thumbnails.goTo', { page: box.index + 1, total })}
              style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
              onClick={() => onSelect(box.index)}
            >
              <span className="thumbs-placeholder" />
              <CachedCanvas
                cache={scheduler.cache}
                cacheKey={cacheKey}
                version={tick}
                className="thumbs-canvas"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ThumbnailsPanel({ onClose, ...list }: ThumbnailsPanelProps) {
  return (
    <Panel title={t('thumbnails.title')} onClose={onClose}>
      <ThumbnailList {...list} />
    </Panel>
  );
}
