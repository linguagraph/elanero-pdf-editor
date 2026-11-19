// The main thread's cache of rendered pages (W1.4 section 6): pixels keyed by document, page,
// revision, scale and rotation, evicted least recently used once the byte budget is exceeded.
// Pure logic; the view draws the cached pixels onto a canvas. Tiles and thumbnails come later.

// 256 MiB of pixels, the budget W1.4 gives the page images (128 MiB on small devices is the
// caller's choice).
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

export interface CachedPage {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
}

export interface PageKey {
  readonly handle: string;
  readonly page: number;
  readonly revision: number;
  readonly scaleMilli: number;
  readonly rotation: number;
}

export function pageCacheKey(key: PageKey): string {
  return [key.handle, key.page, key.revision, key.scaleMilli, key.rotation].join('|');
}

// Thumbnails are whole pages at a small scale, so they share the page key with a suffix. The suffix
// keeps a thumbnail from ever answering a page lookup, even when the two scales happen to match.
export function thumbnailCacheKey(key: PageKey): string {
  return `${pageCacheKey(key)}|thumb`;
}

export class PageCache {
  // Map keeps insertion order, so the first entry is the least recently used.
  private readonly items = new Map<string, CachedPage>();
  private bytes = 0;

  constructor(readonly maxBytes: number = DEFAULT_CACHE_BYTES) {}

  // A hit moves the entry to the most recently used end.
  get(key: string): CachedPage | undefined {
    const item = this.items.get(key);
    if (item === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, item);
    return item;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  // Stores a page and evicts the least recently used others until the budget holds. A page larger
  // than the whole budget is not kept at all, since keeping it would evict everything else.
  set(key: string, item: CachedPage): void {
    const size = item.pixels.byteLength;
    this.delete(key);
    if (size > this.maxBytes) return;
    this.items.set(key, item);
    this.bytes += size;
    for (const [oldKey, old] of this.items) {
      if (this.bytes <= this.maxBytes) break;
      if (oldKey === key) continue;
      this.items.delete(oldKey);
      this.bytes -= old.pixels.byteLength;
    }
  }

  delete(key: string): void {
    const item = this.items.get(key);
    if (item === undefined) return;
    this.items.delete(key);
    this.bytes -= item.pixels.byteLength;
  }

  clear(): void {
    this.items.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.items.size;
  }

  get byteCount(): number {
    return this.bytes;
  }
}
