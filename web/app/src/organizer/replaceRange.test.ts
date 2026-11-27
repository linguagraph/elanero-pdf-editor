import { describe, expect, it } from 'vitest';
import { defaultRange, describePages, sourceRange, UNCHECKED_CAP } from './replaceRange';

describe('defaultRange', () => {
  it('is the desktop default, 1 to min(count, selected)', () => {
    expect(defaultRange(12, 3)).toBe('1-3');
    expect(defaultRange(2, 3)).toBe('1-2');
  });

  it('uses the selection size when the count is unknown', () => {
    expect(defaultRange(null, 4)).toBe('1-4');
  });
});

describe('sourceRange with the count known', () => {
  it('gives the 0-based source pages', () => {
    expect(sourceRange('2-3', 5)).toEqual({ pages: [1, 2] });
  });

  it('a blank range is every page, as the page-range rule says', () => {
    expect(sourceRange('', 3)).toEqual({ pages: [0, 1, 2] });
  });

  it('refuses a page past the file, naming the count', () => {
    expect(sourceRange('6', 5)).toMatchObject({
      message: 'replace.rangeProblem',
      params: { count: 5 },
    });
  });
});

describe('sourceRange with the count unknown (a file over the probe limit)', () => {
  it('accepts ranges with both ends and builds the pages from the numbers typed', () => {
    expect(sourceRange('5, 1-2', null)).toEqual({ pages: [0, 1, 4] });
  });

  it('refuses an open end, a blank or "all", which need the count', () => {
    for (const text of ['3-', '-3', '', 'all']) {
      expect(sourceRange(text, null)).toMatchObject({
        message: 'replace.rangeUnknown',
      });
    }
  });

  it('refuses a number past the cap before any page list is built', () => {
    expect(sourceRange(`1-${UNCHECKED_CAP + 1}`, null)).toMatchObject({
      message: 'replace.rangeUnknown',
    });
  });
});

describe('describePages', () => {
  it('joins consecutive runs of 1-based pages', () => {
    expect(describePages([0, 1, 2, 4, 7])).toBe('1–3, 5, 8');
  });

  it('is empty for no pages and sorts unsorted input', () => {
    expect(describePages([])).toBe('');
    expect(describePages([3, 1])).toBe('2, 4');
  });
});
