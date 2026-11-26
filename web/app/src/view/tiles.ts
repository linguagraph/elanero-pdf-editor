// Whole pages and tiles (W1.4 sections 3 and 4). A page at or under 4 MP of device pixels is one
// render.page image; a larger page is drawn as 1024 x 1024 device-pixel tiles covering the visible
// part plus a one-tile margin, each asked for with render.tile. The engine's page size is
// ceil(points x scale), so the grid here uses the same rounding. Pure arithmetic: the grid is
// tested without a browser.
import { isInViewport, type PageBox, type PageSizePt } from './layout';
import type { PlannedRender } from './renderScheduler';

// W1.4 section 4: viewing tiles are 1024 device pixels on a side (the engine requires this size).
export const TILE_PX = 1024;

// W1.4 section 4: pages up to this many device pixels are one whole-page image.
export const WHOLE_PAGE_MAX_PIXELS = 4_000_000;

export interface DevicePageSize {
  readonly width: number;
  readonly height: number;
}

export interface TileCell {
  readonly tileX: number;
  readonly tileY: number;
}

// The device size of a page at a scale in thousandths, rounded outwards as the engine rounds it.
export function devicePageSize(size: PageSizePt, scaleMilli: number): DevicePageSize {
  return {
    width: Math.ceil((size.width * scaleMilli) / 1000),
    height: Math.ceil((size.height * scaleMilli) / 1000),
  };
}

// Whether a page at this size is drawn as tiles rather than one image.
export function usesTiles(size: DevicePageSize): boolean {
  return size.width * size.height > WHOLE_PAGE_MAX_PIXELS;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The tiles to draw for a page whose visible device rows are [topPx, bottomPx): every column, and
// the rows that cover the visible part with one tile of margin above and below. When the page is
// not in the viewport (a prefetch page), pass the page edge nearest the viewport as both bounds,
// and the tiles along that edge come. Rows are clamped to the grid.
export function visibleTiles(size: DevicePageSize, topPx: number, bottomPx: number): TileCell[] {
  const columns = Math.ceil(size.width / TILE_PX);
  const rows = Math.ceil(size.height / TILE_PX);
  if (columns === 0 || rows === 0) return [];
  const top = clamp(topPx, 0, size.height);
  const bottom = clamp(Math.max(bottomPx, top), 0, size.height);
  const firstVisible = Math.floor(top / TILE_PX);
  const lastVisible = bottom > top ? Math.floor((bottom - 1) / TILE_PX) : firstVisible;
  const first = clamp(firstVisible - 1, 0, rows - 1);
  const last = clamp(lastVisible + 1, 0, rows - 1);
  const cells: TileCell[] = [];
  for (let tileY = first; tileY <= last; tileY += 1) {
    for (let tileX = 0; tileX < columns; tileX += 1) cells.push({ tileX, tileY });
  }
  return cells;
}

// The device rows of a page that the viewport shows, given the page's box in CSS pixels. Rows
// outside the page are clamped by visibleTiles, so the bounds may lie beyond the page.
export function deviceRowsInViewport(
  box: PageBox,
  size: DevicePageSize,
  scrollTop: number,
  viewportHeight: number,
): { readonly top: number; readonly bottom: number } {
  const scale = size.height / box.height;
  return {
    top: (scrollTop - box.top) * scale,
    bottom: (scrollTop + viewportHeight - box.top) * scale,
  };
}

// The tiles of a page that the viewport needs, with the page's device size; null when the page is
// at or under 4 MP and is drawn as one image. The page view and the planner both use this, so they
// agree on which tiles exist.
export function tilesInViewport(
  box: PageBox,
  size: PageSizePt,
  scaleMilli: number,
  scrollTop: number,
  viewportHeight: number,
): { readonly device: DevicePageSize; readonly cells: TileCell[] } | null {
  const device = devicePageSize(size, scaleMilli);
  if (!usesTiles(device)) return null;
  const rows = deviceRowsInViewport(box, device, scrollTop, viewportHeight);
  return { device, cells: visibleTiles(device, rows.top, rows.bottom) };
}

// The rectangle of one tile in device pixels: its origin and its size (edge tiles are smaller).
export function tileRect(
  size: DevicePageSize,
  cell: TileCell,
): { x: number; y: number; width: number; height: number } {
  const x = cell.tileX * TILE_PX;
  const y = cell.tileY * TILE_PX;
  return {
    x,
    y,
    width: Math.min(TILE_PX, size.width - x),
    height: Math.min(TILE_PX, size.height - y),
  };
}

// The renders to plan for the mounted pages (the visible ones and those just outside them): one
// whole-page request for a page at or under 4 MP, and one tile request per tile of a larger page.
// `distance` is measured from the viewport centre, so the queue sends the nearest first. Pages
// outside the viewport are not visible; the queue sends them after the visible ones.
// The page number is the box's index, not its position in `boxes`: in the single-page layout the
// one mounted box is at position 0 but is page `index` (#734), and the view draws that page's cache.
export function planPageRenders(args: {
  readonly boxes: readonly PageBox[];
  readonly sizes: readonly PageSizePt[];
  readonly first: number;
  readonly end: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly scaleMilli: number;
}): PlannedRender[] {
  const planned: PlannedRender[] = [];
  const viewportCentre = args.scrollTop + args.viewportHeight / 2;
  for (let index = args.first; index < args.end; index += 1) {
    const box = args.boxes[index];
    if (box === undefined) continue;
    const size = args.sizes[box.index];
    if (size === undefined) continue;
    const visible = isInViewport(box, args.scrollTop, args.viewportHeight);
    const tiled = tilesInViewport(box, size, args.scaleMilli, args.scrollTop, args.viewportHeight);
    if (tiled === null) {
      planned.push({
        page: box.index,
        scaleMilli: args.scaleMilli,
        visible,
        distance: Math.abs(box.top + box.height / 2 - viewportCentre),
      });
      continue;
    }
    const cssPerDevice = box.height / tiled.device.height;
    for (const cell of tiled.cells) {
      const rect = tileRect(tiled.device, cell);
      const centre = box.top + (rect.y + rect.height / 2) * cssPerDevice;
      planned.push({
        page: box.index,
        scaleMilli: args.scaleMilli,
        visible,
        distance: Math.abs(centre - viewportCentre),
        tileX: cell.tileX,
        tileY: cell.tileY,
      });
    }
  }
  return planned;
}

// The byte budget of the page and tile cache (W1.4 section 6): 256 MiB, or 128 MiB on a device
// that reports 4 GB of memory or less. `deviceMemory` is navigator.deviceMemory, where the browser
// gives it.
export function cacheBudgetBytes(deviceMemory: number | undefined): number {
  const MiB = 1024 * 1024;
  return deviceMemory !== undefined && deviceMemory <= 4 ? 128 * MiB : 256 * MiB;
}
