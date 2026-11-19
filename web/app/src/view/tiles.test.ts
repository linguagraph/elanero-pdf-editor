import { describe, expect, it } from 'vitest';
import type { PageBox } from './layout';
import {
  cacheBudgetBytes,
  devicePageSize,
  planPageRenders,
  TILE_PX,
  tilesInViewport,
  usesTiles,
  visibleTiles,
} from './tiles';
import { scaleMilli } from './zoom';

const MiB = 1024 * 1024;

describe('whole pages and tiles (W1.4 section 4)', () => {
  it('uses one image up to 4 MP and tiles above it', () => {
    expect(usesTiles({ width: 2000, height: 2000 })).toBe(false);
    expect(usesTiles({ width: 2000, height: 2001 })).toBe(true);
    expect(usesTiles({ width: 2667, height: 2667 })).toBe(true);
  });

  it('sizes the device page rounded outwards, as the engine does', () => {
    expect(devicePageSize({ width: 100.2, height: 50 }, 1000)).toEqual({ width: 101, height: 50 });
  });

  it('covers a page with the visible tiles plus one tile of margin', () => {
    // 3 columns and 3 rows (2133 px square); the viewport shows device rows 0..768.
    const size = { width: 2133, height: 2133 };
    expect(visibleTiles(size, 0, 768)).toEqual([
      { tileX: 0, tileY: 0 },
      { tileX: 1, tileY: 0 },
      { tileX: 2, tileY: 0 },
      { tileX: 0, tileY: 1 },
      { tileX: 1, tileY: 1 },
      { tileX: 2, tileY: 1 },
    ]);
  });

  it('adds a margin above and below a viewport in the middle of a tall page', () => {
    // One column, six rows; the view shows rows 2500..3000, which is row 2, so rows 1..3 come.
    const size = { width: 1000, height: 6 * TILE_PX };
    const rows = visibleTiles(size, 2500, 3000).map((cell) => cell.tileY);
    expect(rows).toEqual([1, 2, 3]);
  });

  it('clamps the rows to the page', () => {
    const size = { width: 1000, height: 3 * TILE_PX };
    expect(visibleTiles(size, -500, 100).map((cell) => cell.tileY)).toEqual([0, 1]);
    expect(visibleTiles(size, 2900, 9000).map((cell) => cell.tileY)).toEqual([1, 2]);
  });

  it('gives the edge tiles of a page outside the viewport (prefetch)', () => {
    const size = { width: 1000, height: 5 * TILE_PX };
    // Below the viewport the page's top edge is nearest (row 0 and its margin row 1); above it, the
    // bottom row alone, since there is no row below it to take as margin.
    expect(visibleTiles(size, 0, 0).map((cell) => cell.tileY)).toEqual([0, 1]);
    expect(visibleTiles(size, size.height, size.height).map((cell) => cell.tileY)).toEqual([4]);
  });

  it('returns no tiles for an empty page', () => {
    expect(visibleTiles({ width: 0, height: 0 }, 0, 10)).toEqual([]);
  });

  it('gives no tile grid for a page at or under 4 MP', () => {
    const box: PageBox = { index: 0, top: 0, left: 0, width: 800, height: 1000 };
    expect(tilesInViewport(box, { width: 600, height: 750 }, 1000, 0, 500)).toBeNull();
  });

  it('plans whole-page requests for small pages and tile requests for large ones', () => {
    const boxes: PageBox[] = [
      { index: 0, top: 0, left: 0, width: 800, height: 1056 },
      { index: 1, top: 1072, left: 0, width: 3000, height: 3000 },
    ];
    const sizes = [
      { width: 612, height: 792 },
      { width: 2250, height: 2250 },
    ];
    const planned = planPageRenders({
      boxes,
      sizes,
      first: 0,
      end: 2,
      scrollTop: 0,
      viewportHeight: 768,
      scaleMilli: 1333,
    });
    const whole = planned.filter((item) => item.tileX === undefined);
    const tiles = planned.filter((item) => item.tileX !== undefined);
    expect(whole.map((item) => item.page)).toEqual([0]);
    expect(whole[0]?.visible).toBe(true);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((item) => item.page === 1 && item.tileY !== undefined)).toBe(true);
    expect(tiles.every((item) => item.visible === false)).toBe(true);
  });
});

describe('HiDPI scale (W1.4 section 3)', () => {
  it('includes the device pixel ratio, so a 2x screen renders twice the pixels', () => {
    const one = scaleMilli(1, 1);
    const two = scaleMilli(1, 2);
    // Quantized in 2 % steps, so the ratio is 2 within one step.
    expect(two / one).toBeGreaterThan(1.95);
    expect(two / one).toBeLessThan(2.05);
  });

  it('is the zoom times 96/72 at ratio 1', () => {
    expect(scaleMilli(1, 1)).toBeGreaterThan(1300);
    expect(scaleMilli(1, 1)).toBeLessThan(1370);
  });
});

describe('cache budget (W1.4 section 6)', () => {
  it('is 256 MiB, or 128 MiB on a device with 4 GB or less', () => {
    expect(cacheBudgetBytes(undefined)).toBe(256 * MiB);
    expect(cacheBudgetBytes(8)).toBe(256 * MiB);
    expect(cacheBudgetBytes(4)).toBe(128 * MiB);
    expect(cacheBudgetBytes(2)).toBe(128 * MiB);
  });
});
