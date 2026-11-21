import { describe, expect, it } from 'vitest';
import { isTap, LINK_TAP_SLOP, type LinkPress } from './linkTap';

const press: LinkPress = { pointerId: 1, x: 100, y: 100, page: 0, index: 0 };

describe('isTap', () => {
  it('counts a release within the slop as a tap', () => {
    expect(isTap(press, 1, 100, 100)).toBe(true);
    expect(isTap(press, 1, 100 + LINK_TAP_SLOP, 100 - LINK_TAP_SLOP)).toBe(true);
  });

  it('does not count a release beyond the slop as a tap, so a drag follows nothing', () => {
    expect(isTap(press, 1, 100 + LINK_TAP_SLOP + 1, 100)).toBe(false);
    expect(isTap(press, 1, 100, 60)).toBe(false);
  });

  it('ignores a release from another pointer', () => {
    expect(isTap(press, 2, 100, 100)).toBe(false);
  });
});
