// The single-page layout (W5.1a S3): one page's scene, its placeholder size, and the window and
// anchor that go with it.
import { describe, expect, it } from 'vitest';
import {
  computeColumn,
  type PageSizePt,
  PAGE_GAP_PT,
  singlePageScene,
  scrollTopForAnchor,
  viewAnchor,
  visibleRange,
} from './layout';
import { CSS_PX_PER_POINT } from './zoom';

const PORTRAIT: PageSizePt = { width: 612, height: 792 };
const LANDSCAPE: PageSizePt = { width: 792, height: 612 };
const sizes = [PORTRAIT, LANDSCAPE, { width: 300, height: 400 }];

describe('singlePageScene', () => {
  it('holds only the shown page, one page gap from the top and the left', () => {
    const scene = singlePageScene(sizes, 1, 1);
    const gap = PAGE_GAP_PT * CSS_PX_PER_POINT;
    expect(scene.boxes).toHaveLength(1);
    expect(scene.boxes[0]).toMatchObject({ index: 1, top: gap, left: gap });
    // The content is the page plus a gap on each side (desktop _update_scene_rect inflates it).
    expect(scene.width).toBeCloseTo(LANDSCAPE.width * CSS_PX_PER_POINT + 2 * gap, 6);
    expect(scene.height).toBeCloseTo(LANDSCAPE.height * CSS_PX_PER_POINT + 2 * gap, 6);
  });

  it('gives the placeholder the page own size, landscape and portrait alike', () => {
    const column = computeColumn(sizes, 1.5).boxes;
    for (const index of [0, 1, 2]) {
      const [box] = singlePageScene(sizes, 1.5, index).boxes;
      expect(box?.width).toBeCloseTo(column[index]?.width ?? NaN, 6);
      expect(box?.height).toBeCloseTo(column[index]?.height ?? NaN, 6);
    }
  });

  it('is empty for a page out of range, and for no pages', () => {
    expect(singlePageScene(sizes, 1, 3)).toEqual({ boxes: [], width: 0, height: 0 });
    expect(singlePageScene([], 1, 0).boxes).toEqual([]);
  });

  it('mounts one page at any scroll position', () => {
    const scene = singlePageScene(sizes, 1, 0);
    for (const scroll of [0, 100]) {
      expect(visibleRange(scene.boxes, scroll, 768)).toEqual({ first: 0, end: 1 });
    }
  });

  it('round-trips a place on the shown page, and names no other page', () => {
    const scene = singlePageScene(sizes, 1, 1);
    const anchor = viewAnchor(scene.boxes, 300);
    expect(anchor?.page).toBe(1);
    expect(scrollTopForAnchor(scene.boxes, anchor ?? { page: 0, yFraction: 0 })).toBeCloseTo(
      300,
      6,
    );
    expect(scrollTopForAnchor(scene.boxes, { page: 0, yFraction: 0 })).toBeNull();
  });
});
