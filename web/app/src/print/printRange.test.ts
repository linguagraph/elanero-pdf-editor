import { describe, expect, it } from 'vitest';
import { parsePageRange, resolvePrintPages } from './printRange';

describe('parsePageRange', () => {
  it('reads a list of pages and ranges into sorted zero-based indexes', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('5,1-2,2', 5)).toEqual([0, 1, 4]);
    expect(parsePageRange(' 7 ', 7)).toEqual([6]);
  });

  it.each(['', ' ', '0', '4-2', '1-99', '8', 'a', '1,,2', '3-', '-2', '1.5', '1 2'])(
    'refuses %j',
    (text) => {
      expect(parsePageRange(text, 7)).toBeUndefined();
    },
  );

  it('refuses every range for a document with no pages', () => {
    expect(parsePageRange('1', 0)).toBeUndefined();
  });
});

describe('resolvePrintPages', () => {
  it('prints every page for "all", leaving the pages argument out', () => {
    expect(resolvePrintPages('all', '', 4, 2)).toEqual({ ok: true, pages: undefined });
  });

  it('prints only the current page, one-based as the view reports it', () => {
    expect(resolvePrintPages('current', '', 4, 3)).toEqual({ ok: true, pages: [2] });
    expect(resolvePrintPages('current', '', 4, 5)).toEqual({ ok: false });
  });

  it('reads the typed range only for the range scope', () => {
    expect(resolvePrintPages('range', '1-3, 5', 6, 1)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
    expect(resolvePrintPages('range', '', 6, 1)).toEqual({ ok: false });
    expect(resolvePrintPages('all', '99', 6, 1)).toEqual({ ok: true, pages: undefined });
  });

  it('refuses "all" for an empty document', () => {
    expect(resolvePrintPages('all', '', 0, 1)).toEqual({ ok: false });
  });
});
