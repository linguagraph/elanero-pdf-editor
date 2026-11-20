import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import type { PageSize } from '../rpc/generated';
import { choosePages, pageAreas } from './markPagesChoice';

const SIZES: PageSize[] = [
  { width: 612, height: 792, rotation: 0 },
  { width: 792, height: 612, rotation: 90 }, // rotated: the visible box is landscape
  { width: 595, height: 842, rotation: 0 },
];

describe('choosePages', () => {
  it('marks the current page by default scope', () => {
    expect(choosePages({ scope: 'current', range: '' }, 3, 2)).toEqual({ ok: true, pages: [1] });
  });

  it('marks every page for All', () => {
    expect(choosePages({ scope: 'all', range: '' }, 3, 1)).toEqual({
      ok: true,
      pages: [0, 1, 2],
    });
  });

  it('reads a range as 0-based, sorted and without repeats', () => {
    expect(choosePages({ scope: 'range', range: '3, 1-2, 2' }, 3, 1)).toEqual({
      ok: true,
      pages: [0, 1, 2],
    });
  });

  it('refuses a current page outside the document', () => {
    expect(choosePages({ scope: 'current', range: '' }, 3, 0)).toEqual({
      ok: false,
      message: t('markPages.error.range'),
    });
    expect(choosePages({ scope: 'current', range: '' }, 3, 4).ok).toBe(false);
  });

  it('refuses a range that does not parse or names a page past the end', () => {
    for (const range of ['', 'two', '2-', '3-1', '1-4', '1,,2', '0']) {
      expect(choosePages({ scope: 'range', range }, 3, 1).ok, range).toBe(false);
    }
  });

  it('refuses every scope on an empty document', () => {
    expect(choosePages({ scope: 'all', range: '' }, 0, 1).ok).toBe(false);
    expect(choosePages({ scope: 'range', range: '1' }, 0, 1).ok).toBe(false);
  });
});

describe('pageAreas', () => {
  it('covers each chosen page with its own visible box, rotated pages included', () => {
    expect(pageAreas([0, 1], SIZES)).toEqual([
      { page: 0, rect: { x0: 0, y0: 0, x1: 612, y1: 792 }, quads: [], text: '' },
      { page: 1, rect: { x0: 0, y0: 0, x1: 792, y1: 612 }, quads: [], text: '' },
    ]);
  });

  it('skips a page with no size rather than guessing one', () => {
    expect(pageAreas([2, 5], SIZES).map((area) => area.page)).toEqual([2]);
  });
});
