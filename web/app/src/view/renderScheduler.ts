// The main thread's render scheduler (W1.4 sections 5, 6 and 9): one cache and one in-flight limit
// shared by the document view and the thumbnails panel of a tab. Page renders are always sent
// first; thumbnails go out only when no page render is waiting, so the panel never slows the
// document. Within the pages, the queue sends the visible ones first and the prefetch pages (outside
// the viewport) after them. Each kind has its own queue, since a plan replaces only the entries of
// its own kind.
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';
import { PageCache, pageCacheKey, readDeviceMemory, thumbnailCacheKey } from './pageCache';
import { type QueueEntry, type RenderRequest, RenderQueue, requestKey } from './renderQueue';
import { cacheBudgetBytes, TILE_PX } from './tiles';

// How many times a render is asked for before it is shown as failed. A render that keeps failing
// would otherwise be requested again on every tick, without end.
export const MAX_RENDER_ATTEMPTS = 3;

// The worker answers calls in order, so the scheduler keeps this many requests in flight in all.
export const SCHEDULER_MAX_IN_FLIGHT = 2;

export type RenderKind = 'page' | 'thumb';

export interface TileIndex {
  readonly tileX: number;
  readonly tileY: number;
}

export interface PlannedRender {
  readonly page: number;
  readonly scaleMilli: number;
  // True when the page (or tile) is on screen; those go first within their kind.
  readonly visible: boolean;
  readonly distance: number;
  // A tile of a page drawn as tiles; absent for a whole page image (W1.4 section 4).
  readonly tileX?: number;
  readonly tileY?: number;
}

// The tile of a request or a plan item, or undefined for a whole page.
function tileOf(item: { readonly tileX?: number; readonly tileY?: number }): TileIndex | undefined {
  if (item.tileX === undefined || item.tileY === undefined) return undefined;
  return { tileX: item.tileX, tileY: item.tileY };
}

export class RenderScheduler {
  readonly cache: PageCache;
  private readonly queues: Record<RenderKind, RenderQueue> = {
    page: new RenderQueue(SCHEDULER_MAX_IN_FLIGHT),
    thumb: new RenderQueue(SCHEDULER_MAX_IN_FLIGHT),
  };
  // The cache keys of the visible renders of each kind, from the last plan (pinned in the cache).
  private readonly pins: Record<RenderKind, ReadonlySet<string>> = {
    page: new Set(),
    thumb: new Set(),
  };
  private readonly revisions = new Map<number, number>();
  private readonly attempts = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private inFlight = 0;

  constructor(
    private readonly rpc: PageRpc,
    private readonly handle: string,
    cacheBytes: number = cacheBudgetBytes(readDeviceMemory()),
  ) {
    this.cache = new PageCache(cacheBytes);
  }

  // Called after every reply, so the views can redraw and plan again.
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  revisionOf(page: number): number {
    return this.revisions.get(page) ?? 0;
  }

  // Records the revisions a change reported (W1.2 section 7), so the changed pages are drawn again.
  // The keys are page indexes as strings, as the JSON carries them.
  noteRevisions(revisions: Readonly<Record<string, number>>): void {
    let moved = false;
    for (const [key, revision] of Object.entries(revisions)) {
      const page = Number(key);
      if (this.revisions.get(page) === revision) continue;
      this.revisions.set(page, revision);
      moved = true;
    }
    if (moved) this.notify();
  }

  // The cache key a page, a tile of a page or a thumbnail is drawn from, at the revision the
  // scheduler knows.
  cacheKeyOf(kind: RenderKind, page: number, scaleMilli: number, tile?: TileIndex): string {
    const key = {
      handle: this.handle,
      page,
      revision: this.revisionOf(page),
      scaleMilli,
      rotation: 0,
      tileX: tile?.tileX,
      tileY: tile?.tileY,
    };
    return kind === 'page' ? pageCacheKey(key) : thumbnailCacheKey(key);
  }

  isFailed(cacheKey: string): boolean {
    return this.failed.has(cacheKey);
  }

  // Replaces the wanted renders of one kind. Pages already cached or failed are left out. An empty
  // list drops everything queued for that kind, which a view does when it unmounts. The visible
  // renders of the plan are pinned in the cache, so eviction never takes what is on screen.
  plan(kind: RenderKind, planned: readonly PlannedRender[]): void {
    const entries: QueueEntry[] = [];
    const visibleKeys = new Set<string>();
    for (const item of planned) {
      const tile = tileOf(item);
      const cacheKey = this.cacheKeyOf(kind, item.page, item.scaleMilli, tile);
      if (item.visible) visibleKeys.add(cacheKey);
      if (this.cache.has(cacheKey) || this.failed.has(cacheKey)) continue;
      entries.push({
        request: {
          page: item.page,
          revision: this.revisionOf(item.page),
          scaleMilli: item.scaleMilli,
          rotation: 0,
          tileX: tile?.tileX,
          tileY: tile?.tileY,
        },
        visible: item.visible,
        distance: item.distance,
      });
    }
    this.pins[kind] = visibleKeys;
    this.cache.pin(new Set([...this.pins.page, ...this.pins.thumb]));
    this.queues[kind].plan(entries);
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < SCHEDULER_MAX_IN_FLIGHT) {
      const page = this.queues.page.next();
      if (page !== null) {
        this.send('page', page);
        continue;
      }
      // No page render is waiting, so the thumbnails may go.
      const thumb = this.queues.thumb.next();
      if (thumb === null) return;
      this.send('thumb', thumb);
    }
  }

  private send(kind: RenderKind, request: RenderRequest): void {
    this.inFlight += 1;
    const id = requestKey(request);
    const tile = tileOf(request);
    const cacheKey = this.cacheKeyOf(kind, request.page, request.scaleMilli, tile);
    // The request asks for the revision the caller expects; the reply carries the worker's own.
    const base = {
      handle: this.handle,
      page: request.page,
      revision: request.revision,
      scale_milli: request.scaleMilli,
      rotation: request.rotation,
      annotations: false,
    };
    const pending: Promise<Methods['render.page']['result']> =
      tile === undefined
        ? this.rpc.call('render.page', base)
        : this.rpc.call('render.tile', {
            ...base,
            tile_x: tile.tileX,
            tile_y: tile.tileY,
            tile_px: TILE_PX,
          });
    pending.then(
      (reply) => {
        this.finish(kind, id);
        if (reply.revision === request.revision) {
          this.cache.set(cacheKey, {
            width: reply.width,
            height: reply.height,
            pixels: reply.pixels,
          });
        } else {
          // The page changed since the caller last saw it. The reply carries no pixels, so the
          // page is asked for again at the revision the worker reported.
          this.revisions.set(request.page, reply.revision);
        }
        this.notify();
      },
      () => {
        this.finish(kind, id);
        const count = (this.attempts.get(cacheKey) ?? 0) + 1;
        this.attempts.set(cacheKey, count);
        // Below the cap the next plan asks again; at the cap the render stays failed.
        if (count >= MAX_RENDER_ATTEMPTS) this.failed.add(cacheKey);
        this.notify();
      },
    );
  }

  private finish(kind: RenderKind, id: string): void {
    this.queues[kind].finish(id);
    this.inFlight -= 1;
    this.pump();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
