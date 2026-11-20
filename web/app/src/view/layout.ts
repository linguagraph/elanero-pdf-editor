// The page layouts (W1.4 sections 1 and 7). Pure arithmetic in CSS pixels: the caller gives each
// page's size in points and the zoom, and gets the box of every page. Two layouts: the continuous
// single column, and two-page spreads (the desktop's two-up modes, core/layout.py compute_layout).
import { CSS_PX_PER_POINT, clampZoom, DEFAULT_ZOOM } from './zoom';

// The page layouts the reader can choose (the toolbar and the status bar show them).
export type ViewLayout = 'continuous' | 'twoPage';

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

// The scroll position that puts a page's top edge at the top of the viewport, with the page gap
// above it, so the gap shows as it does between two pages. Null for a page index out of range.
export function scrollTopForPage(
  boxes: readonly PageBox[],
  index: number,
  zoom: number,
): number | null {
  const box = boxes[index];
  if (box === undefined) return null;
  return Math.max(0, box.top - PAGE_GAP_PT * zoom * CSS_PX_PER_POINT);
}

// The scroll position that puts the top of a page's spread at the top of the viewport, for the
// two-page layout: the top of the row holding the page, the one its tallest page starts at. Null
// for a page index out of range.
export function scrollTopForSpread(
  boxes: readonly PageBox[],
  index: number,
  zoom: number,
  firstAlone: boolean,
): number | null {
  if (boxes[index] === undefined) return null;
  for (const row of pairSpreads(boxes.length, firstAlone)) {
    if (!row.includes(index)) continue;
    const rowTop = Math.min(
      ...row.flatMap((member) => {
        const box =
          member === null ? undefined : boxes.find((candidate) => candidate.index === member);
        return box === undefined ? [] : [box.top];
      }),
    );
    return Math.max(0, rowTop - PAGE_GAP_PT * zoom * CSS_PX_PER_POINT);
  }
  return null;
}

// A rectangle on a page, in points (the page's visible space, origin top-left).
export interface PageRectPt {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// The scroll position that brings a rectangle on a page into the viewport. A rectangle already in
// view keeps the scroll it has; otherwise its top-left corner moves to the viewport's top-left,
// backed off by the page gap so it does not sit on the edge. Both axes are handled, since a page
// can be wider than the viewport.
export function scrollForRect(
  box: PageBox,
  rect: PageRectPt,
  zoom: number,
  scroll: { readonly top: number; readonly left: number },
  viewport: { readonly height: number; readonly width: number },
): { top: number; left: number } {
  const k = zoom * CSS_PX_PER_POINT;
  const margin = PAGE_GAP_PT * k;
  return {
    top: revealAxis(
      scroll.top,
      box.top + rect.y0 * k,
      box.top + rect.y1 * k,
      viewport.height,
      margin,
    ),
    left: revealAxis(
      scroll.left,
      box.left + rect.x0 * k,
      box.left + rect.x1 * k,
      viewport.width,
      margin,
    ),
  };
}

function revealAxis(start: number, from: number, to: number, size: number, margin: number): number {
  if (from >= start && to <= start + size) return start;
  return Math.max(0, from - margin);
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

// The view's fit modes (W1.4 section 3): the zoom at which the page width fills the viewport minus
// the page gaps (Fit Width), or the whole page fits (Fit Page). The layout is linear in the zoom, so
// the fitted zoom is the viewport divided by the content size at zoom 1. `columns` is 2 for the
// two-page layout, where a spread holds two pages and three gaps.
export type FitMode = 'width' | 'page';

// The largest width and the largest height of the document's pages: a fit that holds every page.
export function largestPage(sizes: readonly PageSizePt[]): PageSizePt {
  return sizes.reduce(
    (max, size) => ({
      width: Math.max(max.width, size.width),
      height: Math.max(max.height, size.height),
    }),
    { width: 0, height: 0 },
  );
}

// The zoom at which `columns` pages of this width, with their gaps, fill the viewport width. A
// viewport with no width yet (hidden, or before the first layout) gives the actual size.
export function fitWidthZoom(pageWidthPt: number, viewWidthPx: number, columns = 1): number {
  if (!(viewWidthPx > 0) || !(pageWidthPt > 0)) return DEFAULT_ZOOM;
  const contentPt = columns * pageWidthPt + (columns + 1) * PAGE_GAP_PT;
  return clampZoom(viewWidthPx / (CSS_PX_PER_POINT * contentPt));
}

// The zoom at which the page fits the viewport both ways: the smaller of the width fit and the
// height fit, with a page gap above and below it.
export function fitPageZoom(
  pageWidthPt: number,
  pageHeightPt: number,
  viewWidthPx: number,
  viewHeightPx: number,
  columns = 1,
): number {
  const byWidth = fitWidthZoom(pageWidthPt, viewWidthPx, columns);
  if (!(viewHeightPx > 0) || !(pageHeightPt > 0)) return byWidth;
  const byHeight = clampZoom(viewHeightPx / (CSS_PX_PER_POINT * (pageHeightPt + 2 * PAGE_GAP_PT)));
  return Math.min(byWidth, byHeight);
}

// Where the reader is: the page whose box the top of the viewport falls in, and how far down that
// box the top edge is, as a fraction of the page's height. A top edge in the gap above a page gives
// a negative fraction. Every box scales linearly with the zoom and the layout only moves boxes, so
// the same anchor names the same spot after a zoom or a layout change (W5.1a S2).
export interface ViewAnchor {
  readonly page: number;
  readonly yFraction: number;
}

// The anchor at a scroll position. The page is the first whose bottom edge is below the top of the
// viewport (the page the reader sees at the top); past the last page, the last one, with a fraction
// over 1. Null when there are no pages.
export function viewAnchor(boxes: readonly PageBox[], scrollTop: number): ViewAnchor | null {
  const box =
    boxes.find((candidate) => candidate.top + candidate.height > scrollTop) ?? boxes.at(-1);
  if (box === undefined) return null;
  const yFraction = box.height > 0 ? (scrollTop - box.top) / box.height : 0;
  return { page: box.index, yFraction };
}

// The scroll position an anchor names in a layout: the same fraction down the same page. Null for a
// page index out of range.
export function scrollTopForAnchor(boxes: readonly PageBox[], anchor: ViewAnchor): number | null {
  const box = boxes[anchor.page];
  if (box === undefined) return null;
  return Math.max(0, box.top + anchor.yFraction * box.height);
}
