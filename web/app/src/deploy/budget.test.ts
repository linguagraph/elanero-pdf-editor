import { describe, expect, it } from 'vitest';
import { GZIP_BUDGET_BYTES, checkGzipBudget } from './budget';

describe('first-load gzip budget (W9.2)', () => {
  it('is 40 MB, the plan budget', () => {
    expect(GZIP_BUDGET_BYTES).toBe(40_000_000);
  });

  it('sums the gzip sizes of all files', () => {
    const result = checkGzipBudget(
      [
        { path: 'a.js', gzipBytes: 10 },
        { path: 'b.whl', gzipBytes: 15 },
      ],
      100,
    );
    expect(result).toEqual({ totalBytes: 25, budgetBytes: 100, withinBudget: true });
  });

  it('accepts a total equal to the budget and refuses one byte more', () => {
    expect(checkGzipBudget([{ path: 'a', gzipBytes: 100 }], 100).withinBudget).toBe(true);
    expect(checkGzipBudget([{ path: 'a', gzipBytes: 101 }], 100).withinBudget).toBe(false);
  });

  it('uses the default budget when none is given', () => {
    expect(checkGzipBudget([]).budgetBytes).toBe(GZIP_BUDGET_BYTES);
  });
});
