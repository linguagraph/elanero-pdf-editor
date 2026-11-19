// The page range of the print dialog (W6.5, W1.6 section 5). A range is written "1-3, 5" in
// one-based page numbers; the job takes zero-based indexes, sorted and without repeats. Anything
// else is refused before a job starts, so the engine never sees a bad range.

export type PrintScope = 'all' | 'current' | 'range';

export type PrintPages =
  // undefined: every page (the job's `pages` argument is then left out).
  { readonly ok: true; readonly pages: readonly number[] | undefined } | { readonly ok: false };

const ITEM = /^(\d+)(?:-(\d+))?$/;

// Parses "1-3, 5" into sorted zero-based indexes. Returns undefined for any text that is not a
// list of pages or ranges inside 1..pageCount (an empty item, a reversed range and a page past
// the end are all refused).
export function parsePageRange(text: string, pageCount: number): readonly number[] | undefined {
  if (!Number.isInteger(pageCount) || pageCount < 1) return undefined;
  const pages = new Set<number>();
  for (const raw of text.split(',')) {
    const match = ITEM.exec(raw.trim());
    if (match === null) return undefined;
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : Number(match[2]);
    if (first < 1 || last > pageCount || first > last) return undefined;
    for (let page = first; page <= last; page++) pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}

// Resolves the dialog's scope: every page, the current page (one-based, as the view reports it),
// or the typed range.
export function resolvePrintPages(
  scope: PrintScope,
  rangeText: string,
  pageCount: number,
  currentPage: number,
): PrintPages {
  if (scope === 'all') {
    return pageCount >= 1 ? { ok: true, pages: undefined } : { ok: false };
  }
  if (scope === 'current') {
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > pageCount) {
      return { ok: false };
    }
    return { ok: true, pages: [currentPage - 1] };
  }
  const pages = parsePageRange(rangeText, pageCount);
  return pages === undefined ? { ok: false } : { ok: true, pages };
}
