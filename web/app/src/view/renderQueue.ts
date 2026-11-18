// The main thread's render queue (W1.4 section 5). The engine worker answers calls strictly in
// order and cannot be interrupted, so the queue decides what goes to it: at most two requests in
// flight (one rendering, one queued), visible pages first and nearest the viewport centre first,
// and requests for pages that left the window dropped before they are sent. Pure logic: the view
// calls it and does the RPC.

export interface RenderRequest {
  readonly page: number;
  // The page revision the caller expects (W1.4 section 5); the worker answers with its own.
  readonly revision: number;
  readonly scaleMilli: number;
  readonly rotation: number;
}

export interface QueueEntry {
  readonly request: RenderRequest;
  // True when the page intersects the viewport; those go before prefetch pages.
  readonly visible: boolean;
  // Distance from the page centre to the viewport centre; smaller goes first.
  readonly distance: number;
}

export const MAX_IN_FLIGHT = 2;

// Identifies a request within one document. Two requests with the same key render the same pixels.
export function requestKey(request: RenderRequest): string {
  return `${request.page}:${request.revision}:${request.scaleMilli}:${request.rotation}`;
}

function byPriority(a: QueueEntry, b: QueueEntry): number {
  if (a.visible !== b.visible) return a.visible ? -1 : 1;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return a.request.page - b.request.page;
}

export class RenderQueue {
  private queued: QueueEntry[] = [];
  private readonly wanted = new Set<string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly limit: number = MAX_IN_FLIGHT) {}

  // Replaces the queue with the entries now wanted. Requests not wanted any more are dropped
  // here, before they are sent; the keys of the dropped requests are returned. A request already
  // in flight cannot be recalled, so it runs to its end and the caller decides what to do with it
  // (see isWanted). Duplicate keys keep the first, highest-priority entry.
  plan(entries: readonly QueueEntry[]): string[] {
    const sorted = [...entries].sort(byPriority);
    const next: QueueEntry[] = [];
    const keys = new Set<string>();
    for (const entry of sorted) {
      const key = requestKey(entry.request);
      if (keys.has(key) || this.inFlight.has(key)) continue;
      keys.add(key);
      next.push(entry);
    }
    const dropped = this.queued
      .map((entry) => requestKey(entry.request))
      .filter((key) => !keys.has(key));
    this.queued = next;
    this.wanted.clear();
    for (const key of keys) this.wanted.add(key);
    return dropped;
  }

  // The highest-priority queued request, moved to in flight. Null when the limit is reached or
  // nothing is queued.
  next(): RenderRequest | null {
    if (this.inFlight.size >= this.limit) return null;
    const entry = this.queued.shift();
    if (entry === undefined) return null;
    this.inFlight.add(requestKey(entry.request));
    return entry.request;
  }

  // The reply for a request arrived (or it failed); it no longer counts against the limit.
  finish(key: string): void {
    this.inFlight.delete(key);
  }

  // Whether the request was wanted by the last plan. A reply for an unwanted key is still a valid
  // render, so the caller may cache it, but it should not be drawn into a page now off screen.
  isWanted(key: string): boolean {
    return this.wanted.has(key);
  }

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get queuedCount(): number {
    return this.queued.length;
  }

  // The keys in the order they will be sent.
  queuedKeys(): string[] {
    return this.queued.map((entry) => requestKey(entry.request));
  }
}
