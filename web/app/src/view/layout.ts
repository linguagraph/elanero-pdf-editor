// The page layouts (W1.4 sections 1 and 7). Pure arithmetic in CSS pixels: the caller gives each
// page's size in points and the zoom, and gets the box of every page. Two layouts: the continuous
// single column, and two-page spreads (the desktop's two-up modes, core/layout.py compute_layout).
import { CSS_PX_PER_POINT } from './zoom';

// The gap between pages and around the column, in points (core/layout.py PAGE_GAP).
export const PAGE_GAP_PT = 12;

export interface PageSizePt {
  readonly width: number;
  readonly height: number;
}

export interface PageBox {
  readonly index: number;
  // CSS pixels from the top-left of the scroll content.
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface ColumnLayout {
  readonly boxes: readonly PageBox[];
  readonly width: number;
  readonly height: number;
}

// Stacks the pages top to bottom, centred on the widest one. A page's CSS size is its point size
// times zoom times 96/72 (W1.4 section 3); the gap is scaled the same way.
export function computeColumn(sizes: readonly PageSizePt[], zoom: number): ColumnLayout {
  const k = zoom * CSS_PX_PER_POINT;
  const gap = PAGE_GAP_PT * k;
  const widest = sizes.reduce((max, size) => Math.max(max, size.width * k), 0);
  const boxes: PageBox[] = [];
  let top = gap;
  sizes.forEach((size, index) => {
    const width = size.width * k;
    const height = size.height * k;
    boxes.push({ index, top, left: gap + (widest - width) / 2, width, height });
    top += height + gap;
  });
  return {
    boxes,
    width: widest + 2 * gap,
    height: sizes.length === 0 ? 0 : top,
  };
}

// The pages to keep mounted: those intersecting the viewport, grown by one viewport height above
// and below (W1.4 section 7). Returns a half-open range [first, end) of indexes; empty when there
// are no pages. The end is a binary search (page tops only ever grow). The start is a linear scan:
// in a two-page spread the pages of one row have different bottoms, so bottoms are not sorted.
export function visibleRange(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
): { first: number; end: number } {
  if (boxes.length === 0) return { first: 0, end: 0 };
  const margin = Math.max(0, viewportHeight);
  const top = scrollTop - margin;
  const bottom = scrollTop + viewportHeight + margin;
  // The first page whose bottom edge is at or below the top of the window. Every page before it
  // ends above the window, so none of them is needed.
  let first = 0;
  while (first < boxes.length) {
    const box = boxes[first];
    if (box !== undefined && box.top + box.height >= top) break;
    first += 1;
  }
  // First page whose top edge is below the bottom of the window.
  let lo = first;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const box = boxes[mid];
    if (box !== undefined && box.top <= bottom) lo = mid + 1;
    else hi = mid;
  }
  return { first, end: lo };
}

// Which pages share a spread, in reading order: [left, right] with null for an empty slot. Page 1
// is paired with page 2 by default; with `firstAlone`, page 1 is alone on the right of the first
// spread (the desktop's two-up with cover, so a book's cover is a right-hand page).
export function pairSpreads(count: number, firstAlone: boolean): (number | null)[][] {
  if (count <= 0) return [];
  const slots: (number | null)[] = [];
  if (firstAlone) slots.push(null);
  for (let index = 0; index < count; index += 1) slots.push(index);
  const spreads: (number | null)[][] = [];
  for (let i = 0; i < slots.length; i += 2) {
    spreads.push([slots[i] ?? null, slots[i + 1] ?? null]);
  }
  return spreads;
}

// Two-page spreads: each row is as tall as its tallest page, a page is centred vertically in its
// row, the left page hugs the spine and the right page starts one gap after it. Columns are as wide
// as the widest page, so every spread has the same width.
export function computeSpreads(
  sizes: readonly PageSizePt[],
  zoom: number,
  firstAlone: boolean,
): ColumnLayout {
  const k = zoom * CSS_PX_PER_POINT;
  const gap = PAGE_GAP_PT * k;
  const colWidth = sizes.reduce((max, size) => Math.max(max, size.width * k), 0);
  const boxes: PageBox[] = [];
  let top = gap;
  for (const row of pairSpreads(sizes.length, firstAlone)) {
    let rowHeight = 0;
    for (const index of row) {
      const size = index === null ? undefined : sizes[index];
      if (size !== undefined) rowHeight = Math.max(rowHeight, size.height * k);
    }
    row.forEach((index, column) => {
      if (index === null) return;
      const size = sizes[index];
      if (size === undefined) return;
      const width = size.width * k;
      const height = size.height * k;
      const left = column === 0 ? gap + colWidth - width : 2 * gap + colWidth;
      boxes.push({ index, top: top + (rowHeight - height) / 2, left, width, height });
    });
    top += rowHeight + gap;
  }
  boxes.sort((a, b) => a.index - b.index);
  return {
    boxes,
    width: 3 * gap + 2 * colWidth,
    height: sizes.length === 0 ? 0 : top,
  };
}

// Whether a page box intersects the viewport (the visible pages get the first render slots).
export function isInViewport(box: PageBox, scrollTop: number, viewportHeight: number): boolean {
  return box.top < scrollTop + viewportHeight && box.top + box.height > scrollTop;
}

// Distance from the centre of a page to the centre of the viewport, in CSS pixels.
export function distanceToCentre(box: PageBox, scrollTop: number, viewportHeight: number): number {
  return Math.abs(box.top + box.height / 2 - (scrollTop + viewportHeight / 2));
}

// The page the user is reading: the one whose centre is nearest the centre of the viewport. Only
// the pages in the mounted range are compared, which always holds the nearest one. Returns a
// zero-based index, clamped to the document (0 for an empty one).
export function currentPageIndex(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (boxes.length === 0) return 0;
  const { first, end } = visibleRange(boxes, scrollTop, viewportHeight);
  let best = Math.min(first, boxes.length - 1);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = first; index < end; index += 1) {
    const box = boxes[index];
    if (box === undefined) continue;
    const distance = distanceToCentre(box, scrollTop, viewportHeight);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
