// A text selection across pages (W5.4, W1.4 section 10): a TypeScript port of the desktop's
// TextSelection (services/text.py). The anchor and focus are caret positions; the selection covers
// the chars between them in reading order, across the pages in between. Read-only: a selection
// changes no document, so it has no Command and no revision.
import { LINE_SEP, type PageTextIndex } from './pageTextIndex';
import type { AreaRect } from './textLayer';

// A caret position: before char `index` on `page`.
export interface TextPos {
  readonly page: number;
  readonly index: number;
}

// The char range [start, end) a selection covers on one page.
export interface PageSpan {
  readonly page: number;
  readonly start: number;
  readonly end: number;
}

// The indexes of the pages, by page number. The cache satisfies it; tests pass a fake.
export interface PageIndexes {
  get(page: number): PageTextIndex;
}

// Caret order: by page, then by index (the desktop's dataclass order).
export function comparePos(a: TextPos, b: TextPos): number {
  return a.page - b.page || a.index - b.index;
}

export class TextSelection {
  constructor(
    readonly anchor: TextPos,
    readonly focus: TextPos,
  ) {}

  // The selection of a whole page, from its first caret to its last (Select All).
  static ofPage(page: number, length: number): TextSelection {
    return new TextSelection({ page, index: 0 }, { page, index: length });
  }

  get start(): TextPos {
    return comparePos(this.anchor, this.focus) <= 0 ? this.anchor : this.focus;
  }

  get end(): TextPos {
    return comparePos(this.anchor, this.focus) <= 0 ? this.focus : this.anchor;
  }

  get isEmpty(): boolean {
    return comparePos(this.anchor, this.focus) === 0;
  }

  // Whether the selection reaches the page at all (an empty selection covers nothing).
  covers(page: number): boolean {
    return !this.isEmpty && this.start.page <= page && page <= this.end.page;
  }

  // The non-empty char ranges, one per page the selection touches, in page order.
  pageSpans(pages: PageIndexes): PageSpan[] {
    const { start, end } = this;
    const spans: PageSpan[] = [];
    for (let page = start.page; page <= end.page; page += 1) {
      const from = page === start.page ? start.index : 0;
      const to = page === end.page ? end.index : pages.get(page).length;
      if (to > from) spans.push({ page, start: from, end: to });
    }
    return spans;
  }

  // The highlight rectangles on one page: one per line, in visible page space.
  pageRects(pages: PageIndexes, page: number): AreaRect[] {
    if (!this.covers(page)) return [];
    const index = pages.get(page);
    const from = page === this.start.page ? this.start.index : 0;
    const to = page === this.end.page ? this.end.index : index.length;
    return to > from ? index.rects(from, to) : [];
  }

  // The rectangles of every covered page, keyed by page. A page the selection touches is a key
  // even when it has no rectangles (its chars are all separators or boxless).
  rects(pages: PageIndexes): Map<number, AreaRect[]> {
    const out = new Map<number, AreaRect[]>();
    for (const span of this.pageSpans(pages)) {
      out.set(span.page, pages.get(span.page).rects(span.start, span.end));
    }
    return out;
  }

  // The selected text: each page's span, joined with a line break between pages.
  text(pages: PageIndexes): string {
    return this.pageSpans(pages)
      .map((span) => pages.get(span.page).extract(span.start, span.end))
      .join(LINE_SEP);
  }
}

// The selection a drag makes once a long-press has selected a word (W5.4 section 2): the word
// stays whole. A focus before the word keeps the word's end as the anchor, one after it keeps the
// word's start, and one inside it selects just the word.
export function extendFromWord(word: TextSelection, focus: TextPos): TextSelection {
  if (comparePos(focus, word.start) < 0) return new TextSelection(word.end, focus);
  if (comparePos(focus, word.end) > 0) return new TextSelection(word.start, focus);
  return new TextSelection(word.start, word.end);
}

// The size of a selection for the live region (W5.4 section 6). `chars` counts the characters
// without the line separators, and is null when a covered page's index has not arrived yet: then
// only the pages are known. `pages` counts the pages the selection has text on.
export interface SelectionSize {
  readonly pages: number;
  readonly chars: number | null;
}

export function selectedSize(
  selection: TextSelection,
  indexOf: (page: number) => PageTextIndex | undefined,
): SelectionSize {
  if (selection.isEmpty) return { pages: 0, chars: 0 };
  const found = new Map<number, PageTextIndex>();
  for (let page = selection.start.page; page <= selection.end.page; page += 1) {
    const index = indexOf(page);
    if (index === undefined) {
      return { pages: selection.end.page - selection.start.page + 1, chars: null };
    }
    found.set(page, index);
  }
  const spans = selection.pageSpans({
    get: (page) => {
      const index = found.get(page);
      if (index === undefined) throw new Error(`no index for page ${page}`);
      return index;
    },
  });
  let chars = 0;
  for (const span of spans) {
    const text = found.get(span.page)?.extract(span.start, span.end) ?? '';
    chars += Array.from(text).filter((c) => c !== LINE_SEP).length;
  }
  return { pages: spans.length, chars };
}
