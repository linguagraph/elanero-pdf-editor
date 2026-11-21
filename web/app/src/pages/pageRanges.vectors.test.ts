// The page-range rule replayed against the desktop's answers (web/test/vectors/page-ranges.json,
// made by scripts/make_web_vectors.py from services/pages.py). Every case runs in full mode, and
// again in syntax mode: a syntax answer is the full answer, except that a page above the count
// is accepted (it is only known once the file is open).
import { describe, expect, it } from 'vitest';
import rawVectors from '../../../test/vectors/page-ranges.json';
import { parsePageRanges, type PageRangeKind } from './pageRanges';

interface VectorCase {
  readonly text: string;
  readonly page_count: number;
  readonly expect:
    | { readonly pages: readonly number[] }
    | { readonly error: { readonly kind: PageRangeKind; readonly item: string } };
}

const cases = (rawVectors as { readonly cases: readonly VectorCase[] }).cases;

describe('the page-range rule against the desktop vectors', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(40);
  });

  for (const vector of cases) {
    const label = JSON.stringify(vector.text);

    it(`full mode agrees for ${label} on ${vector.page_count} pages`, () => {
      const result = parsePageRanges(vector.text, vector.page_count);
      if ('pages' in vector.expect) {
        expect(result).toEqual({ ok: true, pages: vector.expect.pages });
      } else {
        expect(result).toEqual({ ok: false, error: vector.expect.error });
      }
    });

    it(`syntax mode agrees for ${label}`, () => {
      const result = parsePageRanges(vector.text, null);
      if ('pages' in vector.expect) {
        expect(result).toEqual({ ok: true, pages: null });
      } else if (vector.expect.error.kind === 'out_of_range') {
        expect(result).toEqual({ ok: true, pages: null });
      } else {
        expect(result).toEqual({ ok: false, error: vector.expect.error });
      }
    });
  }

  it('covers every error kind and both separators', () => {
    const kinds = new Set(cases.flatMap((c) => ('error' in c.expect ? [c.expect.error.kind] : [])));
    expect(kinds).toEqual(new Set(['invalid', 'out_of_range', 'empty']));
    expect(cases.some((c) => c.text.includes(';'))).toBe(true);
    expect(cases.some((c) => c.text.includes(','))).toBe(true);
  });
});

describe('the page-range rule, by hand', () => {
  it('reads the open ends and skips blank items', () => {
    expect(parsePageRanges('-2', 5)).toEqual({ ok: true, pages: [0, 1] });
    expect(parsePageRanges('8-', 9)).toEqual({ ok: true, pages: [7, 8] });
    expect(parsePageRanges('5, 1-2', 5)).toEqual({ ok: true, pages: [0, 1, 4] });
  });

  it('gives every page for blank text in either case', () => {
    expect(parsePageRanges('  ', 2)).toEqual({ ok: true, pages: [0, 1] });
    expect(parsePageRanges('ALL', 2)).toEqual({ ok: true, pages: [0, 1] });
  });

  it('keeps the item in its own case', () => {
    expect(parsePageRanges('1, Ab', 5)).toEqual({
      ok: false,
      error: { kind: 'invalid', item: 'Ab' },
    });
  });

  it('compares long numbers exactly', () => {
    const big = '1000000000000000000000001-1000000000000000000000000';
    expect(parsePageRanges(big, 5)).toEqual({
      ok: false,
      error: { kind: 'invalid', item: big },
    });
  });
});
