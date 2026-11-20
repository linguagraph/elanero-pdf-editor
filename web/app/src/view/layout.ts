// The page layouts (W1.4 sections 1 and 7). Pure arithmetic in CSS pixels: the caller gives each
// page's size in points and the zoom, and gets the box of every page. Two layouts: the continuous
// single column, and two-page spreads (the desktop's two-up modes, core/layout.py compute_layout).
import { CSS_PX_PER_POINT, clampZoom, DEFAULT_ZOOM } from './zoom';

// The page layouts the reader can choose (the toolbar and the status bar show them). `single` shows
// one page at a time (core/layout.py SINGLE).
export type ViewLayout = 'continuous' | 'twoPage' | 'single';

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
  // An empty document has no extent (core/layout.py layout_bounds of no rects is 0 x 0).
  if (sizes.length === 0) return { boxes, width: 0, height: 0 };
  return {
    boxes,
    width: widest + 2 * gap,
    height: top,
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

// The single-page layout (W5.1a S3, core/layout.py SINGLE): the pages stack as in the continuous
// column, but the view shows only page `index`. Its scene is that page alone, one page gap from the
// top and the left, so the content is the page plus a gap on each side. The box keeps the page's
// index, so the anchors and the page count still name the document's pages.
export function singlePageScene(
  sizes: readonly PageSizePt[],
  zoom: number,
  index: number,
): ColumnLayout {
  const box = computeColumn(sizes, zoom).boxes[index];
  if (box === undefined) return { boxes: [], width: 0, height: 0 };
  const gap = PAGE_GAP_PT * zoom * CSS_PX_PER_POINT;
  return {
    boxes: [{ ...box, top: gap, left: gap }],
    width: box.width + 2 * gap,
    height: box.height + 2 * gap,
  };
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
  // The extent is the pages present, not two full columns: a lone page in two-up is one page wide
  // (core/layout.py layout_bounds takes the union of the rects and adds one gap on the right).
  if (boxes.length === 0) return { boxes, width: 0, height: 0 };
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  return {
    boxes,
    width: right + gap,
    height: top,
  };
}

// Whether a page box intersects the viewport (the visible pages get the first render slots).
export function isInViewport(box: PageBox, scrollTop: number, viewportHeight: number): boolean {
  return box.top < scrollTop + viewportHeight && box.top + box.height > scrollTop;
}

// The scroll position that puts a page's top edge near the top of the viewport, with half a page
// gap above it (core/layout.py go_to_page aims PAGE_GAP / 2 above the page). Spreads use the same
// rule on the page's own top, not the top of its row. Null for a page index out of range.
export function scrollTopForPage(
  boxes: readonly PageBox[],
  index: number,
  zoom: number,
): number | null {
  const box = boxes[index];
  if (box === undefined) return null;
  return Math.max(0, box.top - (PAGE_GAP_PT / 2) * zoom * CSS_PX_PER_POINT);
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

// The page the user is reading (core/layout.py page_at, as _update_current_page): the page that
// holds the point a third of the way down the viewport. A point in a gap takes the page whose
// nearer edge is closest, and the first page wins a tie. Zero-based; 0 for an empty document.
export function currentPageIndex(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (boxes.length === 0) return 0;
  const y = scrollTop + viewportHeight / 3;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    const bottom = box.top + box.height;
    if (box.top <= y && y <= bottom) return box.index;
    const distance = Math.min(Math.abs(box.top - y), Math.abs(bottom - y));
    if (distance < bestDistance) {
      best = box.index;
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
  const box = boxes.find((candidate) => candidate.index === anchor.page);
  if (box === undefined) return null;
  return Math.max(0, box.top + anchor.yFraction * box.height);
}
