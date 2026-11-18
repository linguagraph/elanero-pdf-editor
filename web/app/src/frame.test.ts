import { describe, expect, it } from 'vitest';
import { shouldRefuse } from './frame';

describe('shouldRefuse', () => {
  it('refuses when the window is framed', () => {
    expect(shouldRefuse({ top: {}, self: {} })).toBe(true);
  });

  it('allows the app when it is the top window', () => {
    const win = {};
    expect(shouldRefuse({ top: win, self: win })).toBe(false);
  });
});
