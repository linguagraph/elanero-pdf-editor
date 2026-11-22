// The page range of the print dialog (W6.5, W1.6 section 5). A range is written "1-3, 5" in
// one-based page numbers; the job takes zero-based indexes, sorted and without repeats. The
// parsing is the shared page-range rule (pages/pageRanges.ts, W6.3), so Print, Crop, Mark Pages and
// Combine read a range the same way. A blank range is refused here, not read as "all": the range
// scope is chosen on purpose, so the box must hold something.

import { type PageRangeFailure, parsePageRanges } from '../pages/pageRanges';

export type PrintScope = 'all' | 'current' | 'range';

export type PrintPages =
  // undefined: every page (the job's `pages` argument is then left out).
  | { readonly ok: true; readonly pages: readonly number[] | undefined }
  // error: the rule's reason for a typed range; null when the scope itself names no pages.
  | { readonly ok: false; readonly error: PageRangeFailure | null };

export type PageRangeCheck =
  | { readonly ok: true; readonly pages: readonly number[] }
  | { readonly ok: false; readonly error: PageRangeFailure };

// Parses "1-3, 5" for a document of pageCount pages into sorted zero-based indexes. Blank text and
// a range that selects no page are refused with kind "empty"; every other refusal is the shared
// rule's own kind and item.
export function parsePageRange(text: string, pageCount: number): PageRangeCheck {
  if (text.trim() === '') return { ok: false, error: { kind: 'empty', item: '' } };
  const result = parsePageRanges(text, pageCount);
  if (!result.ok) return { ok: false, error: result.error };
  const pages = result.pages ?? [];
  if (pages.length === 0) return { ok: false, error: { kind: 'empty', item: '' } };
  return { ok: true, pages };
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
    return pageCount >= 1 ? { ok: true, pages: undefined } : { ok: false, error: null };
  }
  if (scope === 'current') {
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > pageCount) {
      return { ok: false, error: null };
    }
    return { ok: true, pages: [currentPage - 1] };
  }
  const checked = parsePageRange(rangeText, pageCount);
  return checked.ok ? { ok: true, pages: checked.pages } : { ok: false, error: checked.error };
}
