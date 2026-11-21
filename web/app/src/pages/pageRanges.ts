// The page-range rule (W6.3a): the TypeScript port of services/pages.py parse_page_ranges. The
// desktop's answers are in web/test/vectors/page-ranges.json (made by scripts/make_web_vectors.py),
// and pageRanges.vectors.test.ts holds this file to them. Numbers are ASCII digit runs and are
// compared as digit strings, so a long number has the same answer here as in Python.
//
// Full mode (a page count) gives the 0-based pages. Syntax mode (pageCount null) checks everything
// except the page count, for a dialog that does not know the file yet; it gives pages: null.

export type PageRangeKind = 'invalid' | 'out_of_range' | 'empty';

export interface PageRangeFailure {
  readonly kind: PageRangeKind;
  // The item as typed, in its own case; empty for "empty".
  readonly item: string;
}

export type PageRangeResult =
  | { readonly ok: true; readonly pages: readonly number[] | null }
  | { readonly ok: false; readonly error: PageRangeFailure };

const DIGITS = /^[0-9]+$/;

// Compares two digit runs by value, exactly, whatever their length.
function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length - y.length;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function invalid(item: string): PageRangeFailure {
  return { kind: 'invalid', item };
}

interface Span {
  readonly lo: string;
  readonly hi: string;
}

// The 1-based span of one non-blank item, or the failure it earns. The checks run in the same
// order as the desktop: malformed, then page 0 or a reversed span, then a page above the count.
function spanOf(item: string, pageCount: number | null): Span | PageRangeFailure {
  let loText: string;
  let hiText: string;
  let explicitLo = true;
  let explicitHi = true;
  const dash = item.indexOf('-');
  if (dash < 0) {
    if (!DIGITS.test(item)) return invalid(item);
    loText = item;
    hiText = item;
  } else {
    loText = item.slice(0, dash).trim();
    hiText = item.slice(dash + 1).trim();
    if ((loText !== '' && !DIGITS.test(loText)) || (hiText !== '' && !DIGITS.test(hiText))) {
      return invalid(item);
    }
    explicitLo = loText !== '';
    explicitHi = hiText !== '';
  }
  const total = String(pageCount ?? 0);
  const lo = explicitLo ? loText : '1';
  const hi = explicitHi ? hiText : total;
  const isZero = (digits: string): boolean => compareDigits(digits, '0') === 0;
  if ((explicitLo && isZero(lo)) || (explicitHi && isZero(hi))) return invalid(item);
  if (explicitLo && explicitHi && compareDigits(lo, hi) > 0) return invalid(item);
  if (pageCount !== null && (compareDigits(lo, total) > 0 || compareDigits(hi, total) > 0)) {
    return { kind: 'out_of_range', item };
  }
  return { lo, hi };
}

// The page-range rule. Blank text and "all" (any case) mean every page; otherwise the items are
// split on "," or ";", blank items are skipped, and the first bad item decides the error.
export function parsePageRanges(text: string, pageCount: number | null): PageRangeResult {
  const spec = text.trim();
  if (spec === '' || spec.toLowerCase() === 'all') {
    const every = pageCount === null ? null : Array.from({ length: pageCount }, (_, i) => i);
    return { ok: true, pages: every };
  }
  const pages = new Set<number>();
  let items = 0;
  for (const raw of spec.split(/[,;]/)) {
    const item = raw.trim();
    if (item === '') continue;
    const span = spanOf(item, pageCount);
    if (!('lo' in span)) return { ok: false, error: span };
    items += 1;
    if (pageCount !== null) {
      for (let page = Number(span.lo); page <= Number(span.hi); page++) pages.add(page - 1);
    }
  }
  if (items === 0) return { ok: false, error: { kind: 'empty', item: '' } };
  const sorted = pageCount === null ? null : [...pages].sort((a, b) => a - b);
  return { ok: true, pages: sorted };
}
