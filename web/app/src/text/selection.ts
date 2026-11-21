// Maps the browser's text selection to page areas (W4.12 S1). The selection is over the text
// layer's spans (PageTextLayer): each span carries its line index (data-line), and its page element
// carries the page (data-page). The DOM offsets become code-point offsets in the layer's text, so
// the areas come from the same char boxes the engine reported, in visible page space.
import {
  type AreaQuad,
  type AreaRect,
  type PageArea,
  selectionAreas,
  type TextLine,
} from './textLayer';
import type { PageIndexes, TextSelection } from './textSelection';

// The lines of a page as they are shown, or undefined when they have not arrived.
export type TextLineLookup = (page: number) => readonly TextLine[] | undefined;

// What the model says about a command's selection (W5.4). `off` means the model is not in charge
// (the Hand tool, or no view), so the browser's selection is read. `loading` lists the covered pages
// whose index has not arrived, so the command can ask for them. `ready` carries the value, which is
// '' or [] when nothing is selected.
export type ModelRead<T> =
  | { readonly state: 'off' }
  | { readonly state: 'loading'; readonly pages: readonly number[] }
  | { readonly state: 'ready'; readonly value: T };

export const MODEL_OFF: { readonly state: 'off' } = { state: 'off' };

// A code-point span of one page's layer text: [start, end).
interface Extent {
  start: number;
  end: number;
}

// The page areas the selection covers, in page order and then text order. Each DOM range (a
// multi-range selection, e.g. Firefox Ctrl-select) gives its own area per page, so the text in the
// gap between two ranges is not covered. A selection outside the text layer, or on a page whose
// lines have not arrived, gives no area for that page.
export function domSelectionAreas(selection: Selection | null, lookup: TextLineLookup): PageArea[] {
  if (selection === null) return [];
  const extents = new Map<number, Extent[]>();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    for (const [page, extent] of rangeExtents(selection.getRangeAt(index), lookup)) {
      const known = extents.get(page);
      if (known === undefined) extents.set(page, [extent]);
      else known.push(extent);
    }
  }
  const areas: PageArea[] = [];
  for (const page of [...extents.keys()].sort((a, b) => a - b)) {
    const lines = lookup(page);
    if (lines === undefined) continue;
    for (const extent of withoutOverlap(extents.get(page) ?? [])) {
      const area = selectionAreas(lines, page, extent.start, extent.end);
      if (area !== null) areas.push(area);
    }
  }
  return areas;
}

// The extent one range covers on each page (code points), from the line spans it touches.
function rangeExtents(range: Range, lookup: TextLineLookup): Map<number, Extent> {
  const extents = new Map<number, Extent>();
  const root = range.commonAncestorContainer;
  const doc = root.ownerDocument ?? (root as Document);
  doc.querySelectorAll<HTMLElement>('.page-text-line').forEach((span) => {
    if (!range.intersectsNode(span)) return;
    const pageEl = span.closest<HTMLElement>('[data-page]');
    const page = Number(pageEl?.dataset.page);
    const lineIndex = Number(span.dataset.line);
    if (pageEl === null || !Number.isInteger(page) || !Number.isInteger(lineIndex)) return;
    const line = lookup(page)?.[lineIndex];
    const text = span.textContent ?? '';
    // A span whose text is not the line's (a stale revision) is skipped, not mapped to the wrong chars.
    if (line === undefined || line.text !== text) return;
    const from = span.contains(range.startContainer)
      ? domOffset(span, range.startContainer, range.startOffset)
      : 0;
    const to = span.contains(range.endContainer)
      ? domOffset(span, range.endContainer, range.endOffset)
      : text.length;
    if (from >= to) return;
    const start = line.start + codePoints(text.slice(0, from));
    const end = line.start + codePoints(text.slice(0, to));
    const known = extents.get(page);
    extents.set(
      page,
      known === undefined
        ? { start, end }
        : { start: Math.min(known.start, start), end: Math.max(known.end, end) },
    );
  });
  return extents;
}

// Clips overlapping extents of one page so no char is counted twice (ranges that share a line).
// Sorted by start; an extent keeps only the part after the one before it.
function withoutOverlap(extents: readonly Extent[]): Extent[] {
  const sorted = [...extents].sort((a, b) => a.start - b.start);
  const kept: Extent[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const extent of sorted) {
    const start = Math.max(extent.start, cursor);
    if (start >= extent.end) continue;
    kept.push({ start, end: extent.end });
    cursor = extent.end;
  }
  return kept;
}

// The UTF-16 offset of a DOM boundary point inside a span, measured from the span's start.
function domOffset(span: HTMLElement, node: Node, offset: number): number {
  const measure = span.ownerDocument.createRange();
  measure.setStart(span, 0);
  measure.setEnd(node, offset);
  return measure.toString().length;
}

// Counts code points, the engine's index unit (a surrogate pair is one char).
function codePoints(text: string): number {
  return Array.from(text).length;
}

// The page areas of a model selection, one per page it covers with a box, in page order. Each
// line's rect gives one quad, the page's rect is their union, and the text is the span's text (lines
// joined by LINE_SEP), so a mark made from a drag equals the one the browser's ranges gave.
export function modelSelectionAreas(selection: TextSelection, pages: PageIndexes): PageArea[] {
  const areas: PageArea[] = [];
  for (const span of selection.pageSpans(pages)) {
    const index = pages.get(span.page);
    const rects = index.rects(span.start, span.end);
    if (rects.length === 0) continue;
    areas.push({
      page: span.page,
      rect: rects.reduce(unionOf),
      quads: rects.map(quadOf),
      text: index.extract(span.start, span.end),
    });
  }
  return areas;
}

function unionOf(a: AreaRect, b: AreaRect): AreaRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function quadOf(rect: AreaRect): AreaQuad {
  return {
    ul: { x: rect.x0, y: rect.y0 },
    ur: { x: rect.x1, y: rect.y0 },
    ll: { x: rect.x0, y: rect.y1 },
    lr: { x: rect.x1, y: rect.y1 },
  };
}
