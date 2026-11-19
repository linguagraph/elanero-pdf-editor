// The main thread's render scheduler (W1.4 sections 5 and 9): one cache and one in-flight limit
// shared by the document view and the thumbnails panel of a tab. Page renders are always sent
// first; thumbnails go out only when no page render is waiting, so the panel never slows the
// document. Each kind has its own queue, since a plan replaces only the entries of its own kind.
import type { PageRpc } from '../engine/engineConnection';
import { PageCache, pageCacheKey, thumbnailCacheKey } from './pageCache';
import { type QueueEntry, type RenderRequest, RenderQueue, requestKey } from './renderQueue';

// How many times a render is asked for before it is shown as failed. A render that keeps failing
// would otherwise be requested again on every tick, without end.
export const MAX_RENDER_ATTEMPTS = 3;

// The worker answers calls in order, so the scheduler keeps this many requests in flight in all.
export const SCHEDULER_MAX_IN_FLIGHT = 2;

export type RenderKind = 'page' | 'thumb';

export interface PlannedRender {
  readonly page: number;
  readonly scaleMilli: number;
  // True when the page is on screen; those go first within their kind.
  readonly visible: boolean;
  readonly distance: number;
}

export class RenderScheduler {
  readonly cache = new PageCache();
  private readonly queues: Record<RenderKind, RenderQueue> = {
    page: new RenderQueue(SCHEDULER_MAX_IN_FLIGHT),
    thumb: new RenderQueue(SCHEDULER_MAX_IN_FLIGHT),
  };
  private readonly revisions = new Map<number, number>();
  private readonly attempts = new Map<string, number>();
  private readonly failed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private inFlight = 0;

  constructor(
    private readonly rpc: PageRpc,
    private readonly handle: string,
  ) {}

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

  // The cache key a page or thumbnail is drawn from, at the revision the scheduler knows.
  cacheKeyOf(kind: RenderKind, page: number, scaleMilli: number): string {
    const key = {
      handle: this.handle,
      page,
      revision: this.revisionOf(page),
      scaleMilli,
      rotation: 0,
    };
    return kind === 'page' ? pageCacheKey(key) : thumbnailCacheKey(key);
  }

  isFailed(cacheKey: string): boolean {
    return this.failed.has(cacheKey);
  }

  // Replaces the wanted renders of one kind. Pages already cached or failed are left out. An empty
  // list drops everything queued for that kind, which a view does when it unmounts.
  plan(kind: RenderKind, planned: readonly PlannedRender[]): void {
    const entries: QueueEntry[] = [];
    for (const item of planned) {
      const cacheKey = this.cacheKeyOf(kind, item.page, item.scaleMilli);
      if (this.cache.has(cacheKey) || this.failed.has(cacheKey)) continue;
      entries.push({
        request: {
          page: item.page,
          revision: this.revisionOf(item.page),
          scaleMilli: item.scaleMilli,
          rotation: 0,
        },
        visible: item.visible,
        distance: item.distance,
      });
    }
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
      // A page render is waiting for a slot: the thumbnails stay behind it.
      if (this.queues.page.queuedCount > 0) return;
      const thumb = this.queues.thumb.next();
      if (thumb === null) return;
      this.send('thumb', thumb);
    }
  }

  private send(kind: RenderKind, request: RenderRequest): void {
    this.inFlight += 1;
    const id = requestKey(request);
    const key = {
      handle: this.handle,
      page: request.page,
      revision: request.revision,
      scaleMilli: request.scaleMilli,
      rotation: request.rotation,
    };
    const cacheKey = kind === 'page' ? pageCacheKey(key) : thumbnailCacheKey(key);
    this.rpc
      .call('render.page', {
        handle: this.handle,
        page: request.page,
        revision: request.revision,
        scale_milli: request.scaleMilli,
        rotation: request.rotation,
        annotations: false,
      })
      .then(
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
