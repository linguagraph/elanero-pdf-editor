// Reads what the user typed in the split dialog (W6.2). Pure: no engine, no DOM. Pages are typed
// 1-based, as the user reads them, and returned 0-based, as the split job takes them.

// Why a typed value was refused. The dialog maps each kind to a message and the offending item.
export type InputError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid'; readonly item: string }
  | { readonly kind: 'outOfRange'; readonly item: string; readonly count: number };

export type ParseResult =
  | { readonly ok: true; readonly parts: readonly (readonly number[])[] }
  | { readonly ok: false; readonly error: InputError };

const SINGLE = /^(\d+)$/;
const SPAN = /^(\d+)\s*-\s*(\d+)$/;

// "1-3, 5" gives two parts: pages 1, 2, 3 and page 5. Each comma-separated item is one part, so the
// parts keep the order the user typed them in. Every item must be a page or a page span in the
// document, and an empty item (a stray comma) is refused rather than skipped.
export function parseRanges(text: string, pageCount: number): ParseResult {
  if (text.trim() === '') return { ok: false, error: { kind: 'empty' } };
  const parts: number[][] = [];
  for (const raw of text.split(',')) {
    const item = raw.trim();
    const single = SINGLE.exec(item);
    const span = SPAN.exec(item);
    if (single === null && span === null) {
      return { ok: false, error: { kind: 'invalid', item } };
    }
    const first = Number(single?.[1] ?? span?.[1]);
    const last = Number(single?.[1] ?? span?.[2]);
    if (first < 1 || last > pageCount || first > last) {
      if (first > last) return { ok: false, error: { kind: 'invalid', item } };
      return { ok: false, error: { kind: 'outOfRange', item, count: pageCount } };
    }
    const pages: number[] = [];
    for (let page = first; page <= last; page++) pages.push(page - 1);
    parts.push(pages);
  }
  return { ok: true, parts };
}

// The "every N pages" box: a whole number from 1 to the page count. Null when it is not one.
export function parsePagesPerFile(text: string, pageCount: number): number | null {
  if (!SINGLE.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= pageCount ? value : null;
}

// The "largest file" box, in megabytes, as bytes. Null for anything that is not a positive number.
export function parseMegabytes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const megabytes = Number(trimmed);
  return megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : null;
}
