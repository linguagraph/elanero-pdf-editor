// The search panel's pure parts (W5.4, W1.4 section 10): the chunked run over text.search, the
// hit order and the highlight rectangles. Matching itself is the engine's (services/search.py), so
// the case, whole-word and regex rules are the desktop's.
import type { PageRpc } from '../engine/engineConnection';
import type { RectDto, SearchHitDto, SearchOptionsDto } from '../rpc/generated';
import { CSS_PX_PER_POINT } from '../view/zoom';

// The engine's time budget per slice, in milliseconds (W1.4 section 10: about 100 ms a slice).
export const SEARCH_BUDGET_MS = 100;

// What the search panel shows: the hits so far, in page order, and the one selected (-1 for none).
export interface SearchMarks {
  readonly hits: readonly SearchHitDto[];
  readonly current: number;
}

export type SearchRun = 'done' | 'stopped';

// Runs text.search for the whole document in slices, starting at startPage and wrapping round to
// the first page (the desktop's order, W1.4 section 10). Each slice's hits go to onSlice in that
// order. Stopping the signal ends the run after the call in flight; the caller decides what the
// hits so far mean. An error from the engine is thrown, except when the run was stopped.
export async function collectSearch(
  rpc: Pick<PageRpc, 'chunked'>,
  handle: string,
  query: string,
  options: SearchOptionsDto,
  startPage: number,
  signal: AbortSignal,
  onSlice: (hits: readonly SearchHitDto[], pagesDone: number, total: number) => void,
): Promise<SearchRun> {
  try {
    for await (const slice of rpc.chunked(
      'text.search',
      { handle, query, options, start_page: startPage, budget_ms: SEARCH_BUDGET_MS },
      { signal },
    )) {
      if (signal.aborted) return 'stopped';
      onSlice(slice.hits, slice.pages_done, slice.total);
      if (slice.done) return 'done';
    }
    return 'done';
  } catch (error) {
    if (signal.aborted) return 'stopped';
    throw error;
  }
}

// The hit after the current one, wrapping round to the first. -1 means none is selected yet.
export function nextHit(current: number, count: number): number {
  if (count <= 0) return -1;
  return current < 0 ? 0 : (current + 1) % count;
}

// The hit before the current one, wrapping round to the last.
export function previousHit(current: number, count: number): number {
  if (count <= 0) return -1;
  return current < 0 ? count - 1 : (current - 1 + count) % count;
}

// A highlight rectangle in CSS pixels from the page element's top-left corner.
export interface HitRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly current: boolean;
}

// The bounding box of each quad of a hit, placed at the zoom (points times zoom times 96/72).
export function hitRects(hit: SearchHitDto, zoom: number, current: boolean): HitRect[] {
  const k = zoom * CSS_PX_PER_POINT;
  return hit.quads.map((quad) => {
    const xs = [quad.ul.x, quad.ur.x, quad.ll.x, quad.lr.x];
    const ys = [quad.ul.y, quad.ur.y, quad.ll.y, quad.lr.y];
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    return {
      left: x0 * k,
      top: y0 * k,
      width: (Math.max(...xs) - x0) * k,
      height: (Math.max(...ys) - y0) * k,
      current,
    };
  });
}

// The rectangle that covers every quad of a hit, in points (visible page space, origin top-left).
// The view scrolls this into sight when the hit is chosen.
export function hitBounds(hit: SearchHitDto): RectDto {
  const xs = hit.quads.flatMap((quad) => [quad.ul.x, quad.ur.x, quad.ll.x, quad.lr.x]);
  const ys = hit.quads.flatMap((quad) => [quad.ul.y, quad.ur.y, quad.ll.y, quad.lr.y]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

// The highlight rectangles of one page, from every hit on it. The selected hit is marked current.
export function marksOnPage(marks: SearchMarks | undefined, page: number, zoom: number): HitRect[] {
  if (marks === undefined) return [];
  const rects: HitRect[] = [];
  marks.hits.forEach((hit, index) => {
    if (hit.page === page) rects.push(...hitRects(hit, zoom, index === marks.current));
  });
  return rects;
}
