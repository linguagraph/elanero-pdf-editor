import { describe, expect, it } from 'vitest';
import type { PageTextIndex } from './pageTextIndex';
import { extendFromWord, selectedSize, TextSelection } from './textSelection';

// Two pages of text: page 0 is "ab\ncd", page 1 is "xyz". Only what the tests read is modelled.
const TEXTS: Record<number, string> = { 0: 'ab\ncd', 1: 'xyz' };

function fakeIndex(page: number): PageTextIndex {
  const text = TEXTS[page] ?? '';
  return {
    length: text.length,
    extract: (start: number, end: number) => text.slice(start, end),
  } as unknown as PageTextIndex;
}

const word = new TextSelection({ page: 0, index: 3 }, { page: 0, index: 5 }); // "cd"

describe('extendFromWord', () => {
  it('a focus before the word keeps the word end as the anchor', () => {
    const s = extendFromWord(word, { page: 0, index: 0 });
    expect(s.start).toEqual({ page: 0, index: 0 });
    expect(s.end).toEqual({ page: 0, index: 5 });
  });

  it('a focus after the word keeps the word start', () => {
    const s = extendFromWord(word, { page: 1, index: 2 });
    expect(s.start).toEqual({ page: 0, index: 3 });
    expect(s.end).toEqual({ page: 1, index: 2 });
  });

  it('a focus inside the word selects just the word', () => {
    const s = extendFromWord(word, { page: 0, index: 4 });
    expect(s.start).toEqual({ page: 0, index: 3 });
    expect(s.end).toEqual({ page: 0, index: 5 });
  });

  it('a focus on the word edges selects just the word', () => {
    expect(extendFromWord(word, { page: 0, index: 3 }).isEmpty).toBe(false);
    expect(extendFromWord(word, { page: 0, index: 5 }).end).toEqual({ page: 0, index: 5 });
  });
});

describe('selectedSize', () => {
  it('counts characters without the line separators, on one page', () => {
    const s = new TextSelection({ page: 0, index: 0 }, { page: 0, index: 5 });
    expect(selectedSize(s, fakeIndex)).toEqual({ pages: 1, chars: 4 });
  });

  it('counts across pages and adds the pages', () => {
    const s = new TextSelection({ page: 0, index: 4 }, { page: 1, index: 2 });
    expect(selectedSize(s, fakeIndex)).toEqual({ pages: 2, chars: 3 });
  });

  it('an empty selection is nothing', () => {
    const s = new TextSelection({ page: 0, index: 1 }, { page: 0, index: 1 });
    expect(selectedSize(s, fakeIndex)).toEqual({ pages: 0, chars: 0 });
  });

  it('with a covered page not ready, only the pages are known', () => {
    const s = new TextSelection({ page: 0, index: 0 }, { page: 1, index: 2 });
    const onlyFirst = (page: number) => (page === 0 ? fakeIndex(0) : undefined);
    expect(selectedSize(s, onlyFirst)).toEqual({ pages: 2, chars: null });
  });
});
