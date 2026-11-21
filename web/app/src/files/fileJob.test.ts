import { describe, expect, it } from 'vitest';
import type { Notice } from '../engine/loader';
import { progressPercent } from '../feedback/jobRun';

const progress = (data: unknown): Notice => ({ notice: 'progress', id: 1, data }) as Notice;

describe('progressPercent', () => {
  it('gives the share of the total that is done, rounded', () => {
    expect(progressPercent(progress({ done: 1, total: 4, status: '' }))).toBe(25);
    expect(progressPercent(progress({ done: 1, total: 3, status: '' }))).toBe(33);
    expect(progressPercent(progress({ done: 3, total: 3, status: '' }))).toBe(100);
  });

  it('ignores a total of zero or less', () => {
    expect(progressPercent(progress({ done: 0, total: 0, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, total: -2, status: '' }))).toBeUndefined();
  });

  it('ignores a value that is not a number', () => {
    expect(progressPercent(progress({ done: '1', total: 2, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, status: '' }))).toBeUndefined();
    expect(progressPercent(progress({ done: 1, total: null, status: '' }))).toBeUndefined();
  });

  it('ignores a notice that is not progress, or has no data object', () => {
    expect(
      progressPercent({ notice: 'partial', id: 1, data: { done: 1, total: 2 } }),
    ).toBeUndefined();
    expect(progressPercent({ notice: 'progress', id: 1 })).toBeUndefined();
    expect(progressPercent(progress(null))).toBeUndefined();
    expect(progressPercent(progress('1 of 2'))).toBeUndefined();
  });

  it('clamps to 0 and 100', () => {
    expect(progressPercent(progress({ done: 5, total: 2, status: '' }))).toBe(100);
    expect(progressPercent(progress({ done: -1, total: 2, status: '' }))).toBe(0);
  });
});
