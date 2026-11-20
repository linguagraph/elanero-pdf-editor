// Maps the browser's text selection to page areas (W4.12 S1). The selection is over the text
// layer's spans (PageTextLayer): each span carries its line index (data-line), and its page element
// carries the page (data-page). The DOM offsets become code-point offsets in the layer's text, so
// the areas come from the same char boxes the engine reported, in visible page space.
import { type PageArea, selectionAreas, type TextLine } from './textLayer';

// The lines of a page as they are shown, or undefined when they have not arrived.
export type TextLineLookup = (page: number) => readonly TextLine[] | undefined;

// The page areas the selection covers, one per page, in page order. A selection outside the text
// layer, or on a page whose lines have not arrived, gives no area for that page.
export function domSelectionAreas(selection: Selection | null, lookup: TextLineLookup): PageArea[] {
  if (selection === null) return [];
  const extents = new Map<number, { start: number; end: number }>();
  for (let index = 0; index < selection.rangeCount; index += 1) {
    collectRange(selection.getRangeAt(index), lookup, extents);
  }
  const areas: PageArea[] = [];
  for (const page of [...extents.keys()].sort((a, b) => a - b)) {
    const lines = lookup(page);
    const extent = extents.get(page);
    if (lines === undefined || extent === undefined) continue;
    const area = selectionAreas(lines, page, extent.start, extent.end);
    if (area !== null) areas.push(area);
  }
  return areas;
}

// Adds the part of one range that falls in each line span to its page's extent (code points).
function collectRange(
  range: Range,
  lookup: TextLineLookup,
  extents: Map<number, { start: number; end: number }>,
): void {
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
