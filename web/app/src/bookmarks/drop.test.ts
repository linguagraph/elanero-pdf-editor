import { describe, expect, it } from 'vitest';
import { DEFAULT_INDENT_PX, indentPx } from './drop';

describe('indentPx (the --bookmarks-indent computed value)', () => {
  it('reads a rem value at the root font size', () => {
    expect(indentPx('1.25rem', 16)).toBe(20);
    expect(indentPx('2rem', 20)).toBe(40);
  });

  it('reads a px value as it is', () => {
    expect(indentPx('40px', 16)).toBe(40);
    expect(indentPx(' 24px ', 16)).toBe(24);
  });

  it('falls back to 20 px for an empty, unknown or non-positive value', () => {
    expect(indentPx('', 16)).toBe(DEFAULT_INDENT_PX);
    expect(indentPx('calc(1px)', 16)).toBe(DEFAULT_INDENT_PX);
    expect(indentPx('0px', 16)).toBe(DEFAULT_INDENT_PX);
  });
});
