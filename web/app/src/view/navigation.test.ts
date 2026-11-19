import { describe, expect, it } from 'vitest';
import {
  canGoBack,
  canGoForward,
  EMPTY_HISTORY,
  MAX_HISTORY,
  type NavHistory,
  pageLabelFor,
  parsePageInput,
  recordJump,
  stepHistory,
} from './navigation';

describe('pageLabelFor', () => {
  it('shows the document label of a page that has one', () => {
    expect(pageLabelFor(0, ['i', 'ii', '1'])).toBe('i');
    expect(pageLabelFor(2, ['i', 'ii', '1'])).toBe('1');
  });

  it('shows the page number when the page has no label', () => {
    expect(pageLabelFor(4)).toBe('5');
    expect(pageLabelFor(1, ['i', ''])).toBe('2');
    expect(pageLabelFor(3, ['i', 'ii'])).toBe('4');
  });
});

describe('parsePageInput', () => {
  it('reads a one-based page number', () => {
    expect(parsePageInput('3', 10)).toBe(2);
    expect(parsePageInput(' 10 ', 10)).toBe(9);
  });

  it('refuses numbers outside the document and text that is not a number', () => {
    expect(parsePageInput('0', 10)).toBeNull();
    expect(parsePageInput('11', 10)).toBeNull();
    expect(parsePageInput('2.5', 10)).toBeNull();
    expect(parsePageInput('abc', 10)).toBeNull();
    expect(parsePageInput('   ', 10)).toBeNull();
  });

  it('finds a page by its label before reading it as a number', () => {
    const labels = ['i', 'ii', 'iii', '7', '8'];
    expect(parsePageInput('iii', 5, labels)).toBe(2);
    // Label "7" is on page 4, so typing 7 goes to page 4, not page 7.
    expect(parsePageInput('7', 5, labels)).toBe(3);
    expect(parsePageInput('III', 5, labels)).toBeNull();
  });
});

function history(pages: number[], cursor = pages.length - 1): NavHistory {
  return { pages, cursor };
}

describe('recordJump', () => {
  it('records a jump of more than one page, starting from the page left', () => {
    expect(recordJump(EMPTY_HISTORY, 0, 9)).toEqual(history([0, 9]));
  });

  it('does not record a move of one page or none', () => {
    expect(recordJump(EMPTY_HISTORY, 4, 5)).toBe(EMPTY_HISTORY);
    expect(recordJump(EMPTY_HISTORY, 4, 4)).toBe(EMPTY_HISTORY);
  });

  it('does not record the page it is already on twice', () => {
    const once = recordJump(EMPTY_HISTORY, 0, 9);
    expect(recordJump(once, 9, 0).pages).toEqual([0, 9, 0]);
    expect(recordJump(history([3], 0), 3, 20).pages).toEqual([3, 20]);
  });

  it('drops the forward entries when a new jump follows going back', () => {
    const three = recordJump(recordJump(EMPTY_HISTORY, 0, 5), 5, 10);
    expect(three.pages).toEqual([0, 5, 10]);
    const back = stepHistory(three, -1);
    expect(back?.page).toBe(5);
    const branched = recordJump(back?.history ?? three, 5, 20);
    expect(branched.pages).toEqual([0, 5, 20]);
    expect(canGoForward(branched)).toBe(false);
  });

  it('keeps at most MAX_HISTORY entries, dropping the oldest', () => {
    let state = EMPTY_HISTORY;
    // Each jump adds two entries (the page left and the page reached), so 120 jumps overflow.
    for (let jump = 0; jump < 120; jump += 1) {
      state = recordJump(state, jump * 10, jump * 10 + 5);
    }
    expect(state.pages.length).toBe(MAX_HISTORY);
    expect(state.cursor).toBe(MAX_HISTORY - 1);
    expect(state.pages[state.pages.length - 1]).toBe(119 * 10 + 5);
  });
});

describe('stepHistory', () => {
  it('moves back and forward through the recorded pages', () => {
    const state = recordJump(recordJump(EMPTY_HISTORY, 0, 5), 5, 10);
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(false);
    const back = stepHistory(state, -1);
    expect(back?.page).toBe(5);
    const back2 = stepHistory(back?.history ?? state, -1);
    expect(back2?.page).toBe(0);
    expect(stepHistory(back2?.history ?? state, -1)).toBeNull();
    const forward = stepHistory(back2?.history ?? state, 1);
    expect(forward?.page).toBe(5);
    expect(stepHistory(forward?.history ?? state, 1)?.page).toBe(10);
    expect(stepHistory(EMPTY_HISTORY, 1)).toBeNull();
  });
});
