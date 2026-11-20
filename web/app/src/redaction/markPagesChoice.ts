// Mark Pages (W4.13 S3): the pages the dialog chose, and one page-sized mark for each. The mark's box
// is the page's visible space (points, origin top-left, /Rotate and CropBox applied, from
// session.pages), so a rotated page is covered as the user sees it. Nothing is applied here.
import { t } from '../i18n/t';
import { parsePageRange } from '../print/printRange';
import type { PageSize } from '../rpc/generated';
import type { PageArea } from '../text/textLayer';

export type MarkPagesScope = 'current' | 'all' | 'range';

// What the form holds. The range is text, as typed; it is read only when the scope is range.
export interface MarkPagesValues {
  readonly scope: MarkPagesScope;
  readonly range: string;
}

export type MarkPagesCheck =
  | { readonly ok: true; readonly pages: readonly number[] } // 0-based, sorted
  | { readonly ok: false; readonly message: string };

// The pages the scope names. A current page outside the document, an empty document, and a range
// that does not parse are all refused before anything is marked.
export function choosePages(
  values: MarkPagesValues,
  pageCount: number,
  currentPage: number /* 1-based, as the view reports it */,
): MarkPagesCheck {
  const refused = { ok: false as const, message: t('markPages.error.range') };
  if (values.scope === 'all') {
    if (pageCount < 1) return refused;
    return { ok: true, pages: Array.from({ length: pageCount }, (_, index) => index) };
  }
  if (values.scope === 'current') {
    if (!Number.isInteger(currentPage) || currentPage < 1 || currentPage > pageCount)
      return refused;
    return { ok: true, pages: [currentPage - 1] };
  }
  const pages = parsePageRange(values.range, pageCount);
  if (pages === undefined || pages.length === 0) return refused;
  return { ok: true, pages };
}

// One area per chosen page, covering its whole visible box. A page with no size in the list is
// skipped rather than guessed at; the caller checks the pages against the same list first.
export function pageAreas(pages: readonly number[], sizes: readonly PageSize[]): PageArea[] {
  const areas: PageArea[] = [];
  for (const index of pages) {
    const size = sizes[index];
    if (size === undefined) continue;
    areas.push({
      page: index,
      rect: { x0: 0, y0: 0, x1: size.width, y1: size.height },
      quads: [],
      text: '',
    });
  }
  return areas;
}
