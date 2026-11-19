import { describe, expect, it } from 'vitest';
import { type CachedPage, PageCache, pageCacheKey } from './pageCache';

function page(bytes: number): CachedPage {
  return { width: bytes / 4, height: 1, pixels: new ArrayBuffer(bytes) };
}

describe('PageCache', () => {
  it('returns what was stored and misses other keys', () => {
    const cache = new PageCache(1000);
    const item = page(100);
    cache.set('a', item);
    expect(cache.get('a')).toBe(item);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.byteCount).toBe(100);
  });

  it('evicts the least recently used page at the size limit', () => {
    const cache = new PageCache(300);
    cache.set('a', page(100));
    cache.set('b', page(100));
    cache.set('c', page(100));
    cache.get('a'); // a is now the most recently used
    cache.set('d', page(100)); // evicts b, the least recently used
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
    expect(cache.byteCount).toBe(300);
  });

  it('keeps the byte total within the limit', () => {
    const cache = new PageCache(250);
    for (let i = 0; i < 20; i += 1) cache.set(`k${i}`, page(100));
    expect(cache.byteCount).toBeLessThanOrEqual(250);
    expect(cache.size).toBe(2);
  });

  it('does not keep a page larger than the whole budget', () => {
    const cache = new PageCache(100);
    cache.set('small', page(50));
    cache.set('huge', page(500));
    expect(cache.has('huge')).toBe(false);
    expect(cache.has('small')).toBe(true);
  });

  it('replaces an entry with the same key without double counting', () => {
    const cache = new PageCache(1000);
    cache.set('a', page(100));
    cache.set('a', page(200));
    expect(cache.byteCount).toBe(200);
    expect(cache.size).toBe(1);
  });

  it('changes the key when any part changes, so a change misses', () => {
    const base = { handle: 'h', page: 0, revision: 0, scaleMilli: 1000, rotation: 0 };
    const keys = [
      pageCacheKey(base),
      pageCacheKey({ ...base, handle: 'other' }),
      pageCacheKey({ ...base, page: 1 }),
      pageCacheKey({ ...base, revision: 1 }),
      pageCacheKey({ ...base, scaleMilli: 1020 }),
      pageCacheKey({ ...base, rotation: 90 }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    const cache = new PageCache(1000);
    cache.set(keys[0] ?? '', page(4));
    expect(cache.has(keys[4] ?? '')).toBe(false);
  });

  it('clears everything', () => {
    const cache = new PageCache(1000);
    cache.set('a', page(100));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteCount).toBe(0);
  });
});

describe('PageCache budget and pins (W1.4 section 6)', () => {
  it('never evicts a pinned bitmap, even over the budget', () => {
    const cache = new PageCache(300);
    cache.set('visible', page(100));
    cache.set('b', page(100));
    cache.pin(new Set(['visible']));
    cache.set('c', page(100));
    cache.set('d', page(100));
    expect(cache.has('visible')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.byteCount).toBeLessThanOrEqual(300);
  });

  it('lets the cache exceed the budget when only pinned bitmaps are left', () => {
    const cache = new PageCache(200);
    cache.set('a', page(100));
    cache.set('b', page(100));
    cache.pin(new Set(['a', 'b']));
    cache.set('c', page(100));
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.byteCount).toBe(300);
  });

  it('keys a whole page with -1 tile coordinates and each tile apart', () => {
    const base = { handle: 'h', page: 2, revision: 0, scaleMilli: 1000, rotation: 0 };
    expect(pageCacheKey(base)).toBe('h|2|0|1000|0|-1|-1');
    const tile00 = pageCacheKey({ ...base, tileX: 0, tileY: 0 });
    const tile10 = pageCacheKey({ ...base, tileX: 1, tileY: 0 });
    expect(tile00).not.toBe(pageCacheKey(base));
    expect(tile00).not.toBe(tile10);
  });
});
