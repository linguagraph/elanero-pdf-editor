// The main thread's cache of rendered pages (W1.4 section 6): pixels keyed by document, page,
// revision, scale and rotation, evicted least recently used once the byte budget is exceeded.
// Pure logic; the view draws the cached pixels onto a canvas. Tiles and thumbnails come later.

// 256 MiB of pixels, the budget W1.4 gives the page images (128 MiB on small devices is the
// caller's choice).
export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;

export interface CachedPage {
  readonly width: number;
  readonly height: number;
  // The pixels of a page the worker sent as an ArrayBuffer. A page the worker drew into an
  // ImageBitmap (W5.1b S5) carries an empty buffer here and the bitmap beside it.
  readonly pixels: ArrayBuffer;
  readonly bitmap?: ImageBitmap;
}

// The bytes an entry takes in the budget. A bitmap is counted at its decoded size (4 bytes a
// pixel), since the GPU copy is what the budget stands for, not the empty buffer beside it.
function sizeOf(item: CachedPage): number {
  return item.bitmap === undefined ? item.pixels.byteLength : item.width * item.height * 4;
}

// Releases a bitmap the cache holds. Closing frees its GPU memory at once, so it must happen only
// when the cache drops the entry, never while a canvas may still draw it.
function closeBitmap(item: CachedPage): void {
  item.bitmap?.close();
}

export interface PageKey {
  readonly handle: string;
  readonly page: number;
  readonly revision: number;
  readonly scaleMilli: number;
  readonly rotation: number;
  // The tile of a page drawn as tiles (W1.4 section 4); -1 for a whole page image.
  readonly tileX?: number;
  readonly tileY?: number;
}

export function pageCacheKey(key: PageKey): string {
  const tileX = key.tileX ?? -1;
  const tileY = key.tileY ?? -1;
  return [key.handle, key.page, key.revision, key.scaleMilli, key.rotation, tileX, tileY].join('|');
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
  // Bitmaps covering the visible area (W1.4 section 6). Eviction skips them, so the budget can be
  // exceeded while they are needed; the view replaces the set each time it plans.
  private pinned: ReadonlySet<string> = new Set();

  constructor(readonly maxBytes: number = DEFAULT_CACHE_BYTES) {}

  pin(keys: ReadonlySet<string>): void {
    this.pinned = keys;
  }

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

  // Stores a page and evicts the least recently used unpinned pages until the budget holds. A page
  // larger than the whole budget is not kept at all, since keeping it would evict everything else.
  set(key: string, item: CachedPage): void {
    const size = sizeOf(item);
    this.delete(key);
    if (size > this.maxBytes) {
      // Not kept, so nothing else will release its bitmap.
      closeBitmap(item);
      return;
    }
    this.items.set(key, item);
    this.bytes += size;
    for (const [oldKey, old] of this.items) {
      if (this.bytes <= this.maxBytes) break;
      if (oldKey === key || this.pinned.has(oldKey)) continue;
      this.items.delete(oldKey);
      this.bytes -= sizeOf(old);
      closeBitmap(old);
    }
  }

  delete(key: string): void {
    const item = this.items.get(key);
    if (item === undefined) return;
    this.items.delete(key);
    this.bytes -= sizeOf(item);
    closeBitmap(item);
  }

  clear(): void {
    for (const item of this.items.values()) closeBitmap(item);
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

// navigator.deviceMemory in GiB where the browser reports it, undefined elsewhere (Safari, Firefox).
export function readDeviceMemory(): number | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return typeof memory === 'number' ? memory : undefined;
}
