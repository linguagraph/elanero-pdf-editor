import { describe, expect, it } from 'vitest';
import { parsePageRange, resolvePrintPages } from './printRange';

describe('parsePageRange', () => {
  it('reads a list of pages and ranges into sorted zero-based indexes', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
    expect(parsePageRange('5,1-2,2', 5)).toEqual({ ok: true, pages: [0, 1, 4] });
    expect(parsePageRange(' 7 ', 7)).toEqual({ ok: true, pages: [6] });
  });

  // Each case is a row of web/test/vectors/page-ranges.json, so the dialog refuses or accepts
  // exactly what the desktop does (the vector test checks the rule itself).
  it('accepts what the shared rule accepts', () => {
    expect(parsePageRange('1 - 3', 5)).toEqual({ ok: true, pages: [0, 1, 2] });
    expect(parsePageRange('2;2,2', 5)).toEqual({ ok: true, pages: [1] });
    expect(parsePageRange('1,,2', 5)).toEqual({ ok: true, pages: [0, 1] });
    expect(parsePageRange('-', 5)).toEqual({ ok: true, pages: [0, 1, 2, 3, 4] });
  });

  it('refuses what the shared rule refuses, with its kind and item', () => {
    expect(parsePageRange('3-2', 5)).toEqual({
      ok: false,
      error: { kind: 'invalid', item: '3-2' },
    });
    expect(parsePageRange('1-2-3', 5)).toEqual({
      ok: false,
      error: { kind: 'invalid', item: '1-2-3' },
    });
    expect(parsePageRange('9', 5)).toEqual({
      ok: false,
      error: { kind: 'out_of_range', item: '9' },
    });
    expect(parsePageRange('1', 0)).toEqual({
      ok: false,
      error: { kind: 'out_of_range', item: '1' },
    });
  });

  it('refuses a blank range, which the range scope needs typed', () => {
    expect(parsePageRange('', 7)).toEqual({ ok: false, error: { kind: 'empty', item: '' } });
    expect(parsePageRange(' ', 7)).toEqual({ ok: false, error: { kind: 'empty', item: '' } });
  });

  it('refuses a list that selects no page', () => {
    expect(parsePageRange(',', 7)).toEqual({ ok: false, error: { kind: 'empty', item: '' } });
  });
});

describe('resolvePrintPages', () => {
  it('prints every page for "all", leaving the pages argument out', () => {
    expect(resolvePrintPages('all', '', 4, 2)).toEqual({ ok: true, pages: undefined });
  });

  it('prints only the current page, one-based as the view reports it', () => {
    expect(resolvePrintPages('current', '', 4, 3)).toEqual({ ok: true, pages: [2] });
    expect(resolvePrintPages('current', '', 4, 5)).toEqual({ ok: false, error: null });
  });

  it('reads the typed range only for the range scope', () => {
    expect(resolvePrintPages('range', '1-3, 5', 6, 1)).toEqual({ ok: true, pages: [0, 1, 2, 4] });
    expect(resolvePrintPages('range', '', 6, 1)).toEqual({
      ok: false,
      error: { kind: 'empty', item: '' },
    });
    expect(resolvePrintPages('all', '99', 6, 1)).toEqual({ ok: true, pages: undefined });
  });

  it('gives the shared rule error for a typed range that fails', () => {
    expect(resolvePrintPages('range', '1-9', 6, 1)).toEqual({
      ok: false,
      error: { kind: 'out_of_range', item: '1-9' },
    });
  });

  it('refuses "all" for an empty document', () => {
    expect(resolvePrintPages('all', '', 0, 1)).toEqual({ ok: false, error: null });
  });
});
