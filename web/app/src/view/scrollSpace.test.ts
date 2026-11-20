import { describe, expect, it } from 'vitest';
import { computeColumn, scrollTopForPage, viewAnchor } from './layout';
import {
  SCROLL_SPACE_MAX,
  isScaledSpace,
  sceneTopForScroll,
  scrollPerScenePixel,
  scrollTopForSceneTop,
  spacerHeight,
} from './scrollSpace';

const VIEW = 800;
// 1000 Letter pages at 6400 %: about 67.6 M CSS px, past the limit.
const LONG = computeColumn(
  Array.from({ length: 1000 }, () => ({ width: 612, height: 792 })),
  64,
);
const H = LONG.height;
const SPACER = spacerHeight(H);
const maxScroll = SPACER - VIEW;

describe('the scaled scroll space', () => {
  it('is the identity at and below the limit', () => {
    expect(isScaledSpace(SCROLL_SPACE_MAX)).toBe(false);
    expect(spacerHeight(5_000_000)).toBe(5_000_000);
    for (const scrollTop of [0, 1234, 4_000_000]) {
      expect(sceneTopForScroll(scrollTop, 5_000_000, VIEW)).toBe(scrollTop);
      expect(scrollTopForSceneTop(scrollTop, 5_000_000, VIEW)).toBe(scrollTop);
    }
    expect(scrollPerScenePixel(SCROLL_SPACE_MAX, VIEW)).toBe(1);
  });

  it('caps the spacer at the limit beyond it', () => {
    expect(isScaledSpace(H)).toBe(true);
    expect(SPACER).toBe(SCROLL_SPACE_MAX);
  });

  it('meets both ends: the top is the top and the last scroll position is the layout bottom', () => {
    expect(sceneTopForScroll(0, H, VIEW)).toBe(0);
    expect(sceneTopForScroll(maxScroll, H, VIEW)).toBeCloseTo(H - VIEW, 6);
    expect(scrollTopForSceneTop(0, H, VIEW)).toBe(0);
    expect(scrollTopForSceneTop(H - VIEW, H, VIEW)).toBeCloseTo(maxScroll, 6);
  });

  it('maps the middle of the spacer to the middle of the layout', () => {
    expect(sceneTopForScroll(maxScroll / 2, H, VIEW)).toBeCloseTo((H - VIEW) / 2, 6);
  });

  it('is monotonic and its inverse round-trips across the range', () => {
    let previous = -1;
    for (let step = 0; step <= 100; step += 1) {
      const scrollTop = (maxScroll * step) / 100;
      const sceneTop = sceneTopForScroll(scrollTop, H, VIEW);
      expect(sceneTop).toBeGreaterThan(previous);
      previous = sceneTop;
      expect(scrollTopForSceneTop(sceneTop, H, VIEW)).toBeCloseTo(scrollTop, 6);
    }
  });

  it('clamps positions outside the range', () => {
    expect(sceneTopForScroll(-50, H, VIEW)).toBe(0);
    expect(sceneTopForScroll(maxScroll + 500, H, VIEW)).toBeCloseTo(H - VIEW, 6);
    expect(scrollTopForSceneTop(H + 9000, H, VIEW)).toBeCloseTo(maxScroll, 6);
  });

  it('maps a page to its own place: the first, a middle and the last page at the top of the view', () => {
    for (const index of [0, 500, 999]) {
      const target = scrollTopForPage(LONG.boxes, index, 64) ?? -1;
      const scrollTop = scrollTopForSceneTop(target, H, VIEW);
      const sceneTop = sceneTopForScroll(scrollTop, H, VIEW);
      expect(sceneTop).toBeCloseTo(target, 3);
      expect(viewAnchor(LONG.boxes, sceneTop)?.page).toBe(index);
    }
    // The last page sits at the very end of the scroll range, so it is reachable.
    expect(
      scrollTopForSceneTop(scrollTopForPage(LONG.boxes, 999, 64) ?? 0, H, VIEW),
    ).toBeLessThanOrEqual(maxScroll);
  });

  it('scales a drag by the ratio of the two ranges, and not at all below the limit', () => {
    expect(scrollPerScenePixel(H, VIEW)).toBeCloseTo((SPACER - VIEW) / (H - VIEW), 9);
    expect(scrollPerScenePixel(H, VIEW)).toBeLessThan(1);
  });
});
