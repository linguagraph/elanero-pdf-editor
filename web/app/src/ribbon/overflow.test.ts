// The overflow rules of the ribbon's groups (W4.3a S3, ribbon/overflow.ts), without a browser.
import { describe, expect, it } from 'vitest';
import { visibleGroupCount } from './overflow';

describe('visibleGroupCount', () => {
  it('keeps every group and needs no menu button when all fit', () => {
    expect(visibleGroupCount([100, 100, 100], 300, 40)).toBe(3);
  });

  it('keeps every group when the total is exactly the available width (inclusive)', () => {
    expect(visibleGroupCount([100, 100, 100], 300, 0)).toBe(3);
  });

  it('moves a group out when the total is one pixel over the available width', () => {
    // 300 + 40 > 299, so the menu button is needed; 100 + 40 = 140 fits, 200 + 40 = 240 fits.
    expect(visibleGroupCount([100, 100, 100], 299, 40)).toBe(2);
  });

  it('pushes one more group out when the menu button takes its room', () => {
    // Without the button 250 px holds two groups; with a 60 px button, 200 + 60 = 260 is too wide.
    expect(visibleGroupCount([100, 100, 100], 250, 60)).toBe(1);
    expect(visibleGroupCount([100, 100, 100], 250, 50)).toBe(2);
  });

  it('keeps no group when the available width is 0', () => {
    expect(visibleGroupCount([100, 100], 0, 40)).toBe(0);
  });

  it('keeps no group when only the menu button fits', () => {
    expect(visibleGroupCount([100, 100], 40, 40)).toBe(0);
  });

  it('returns 0 for an empty list, with or without room', () => {
    expect(visibleGroupCount([], 300, 40)).toBe(0);
    expect(visibleGroupCount([], 0, 40)).toBe(0);
  });

  it('keeps the groups from the left and never skips one to fit a later one', () => {
    // The 300 px group does not fit, so the 50 px group after it is not kept either.
    expect(visibleGroupCount([100, 300, 50], 200, 40)).toBe(1);
  });
});
