import { describe, expect, it } from 'vitest';
import { scrollTopForPage, computeColumn } from './layout';
import { pageCacheKey, thumbnailCacheKey } from './pageCache';
import {
  THUMBNAIL_GAP_CSS_PX,
  THUMBNAIL_WIDTH_CSS_PX,
  thumbnailBoxes,
  thumbnailScaleMilli,
  thumbnailWindow,
} from './thumbnails';

// The device width a render at this scale gives a page, in device pixels.
function deviceWidth(width: number, scaleMilli: number): number {
  return width * (scaleMilli / 1000);
}

describe('thumbnail scale', () => {
  it('renders a Letter page about 160 px wide at devicePixelRatio 1', () => {
    const scale = thumbnailScaleMilli({ width: 612, height: 792, rotation: 0 }, 1);
    expect(Math.abs(deviceWidth(612, scale) - THUMBNAIL_WIDTH_CSS_PX)).toBeLessThan(4);
  });

  it('scales with the device pixel ratio, so a 2x screen gets about 320 device px', () => {
    const scale = thumbnailScaleMilli({ width: 612, height: 792, rotation: 0 }, 2);
    expect(Math.abs(deviceWidth(612, scale) - 2 * THUMBNAIL_WIDTH_CSS_PX)).toBeLessThan(8);
  });

  it('uses the visible width of a rotated page, which session.pages already reports', () => {
    // A landscape page turned by /Rotate 90: the reply's width is the visible width.
    const scale = thumbnailScaleMilli({ width: 792, height: 612, rotation: 90 }, 1);
    expect(Math.abs(deviceWidth(792, scale) - THUMBNAIL_WIDTH_CSS_PX)).toBeLessThan(4);
  });

  it('gives a thumbnail a scale of its own, not the page render scale', () => {
    const scale = thumbnailScaleMilli({ width: 612, height: 792, rotation: 0 }, 1);
    expect(
      thumbnailCacheKey({ handle: 'h', page: 0, revision: 0, scaleMilli: scale, rotation: 0 }),
    ).not.toBe(pageCacheKey({ handle: 'h', page: 0, revision: 0, scaleMilli: scale, rotation: 0 }));
  });
});

describe('thumbnail boxes', () => {
  it('keeps each page shape at the thumbnail width and stacks them with a gap', () => {
    const { boxes, height } = thumbnailBoxes([
      { width: 612, height: 792, rotation: 0 },
      { width: 792, height: 612, rotation: 0 },
    ]);
    expect(boxes[0]?.width).toBe(THUMBNAIL_WIDTH_CSS_PX);
    expect(boxes[0]?.height).toBeCloseTo((792 / 612) * THUMBNAIL_WIDTH_CSS_PX);
    expect(boxes[1]?.top).toBeCloseTo(
      (boxes[0]?.top ?? 0) + (boxes[0]?.height ?? 0) + THUMBNAIL_GAP_CSS_PX,
    );
    expect(height).toBeCloseTo(
      (boxes[1]?.top ?? 0) + (boxes[1]?.height ?? 0) + THUMBNAIL_GAP_CSS_PX,
    );
  });

  it('has no height for an empty document', () => {
    expect(thumbnailBoxes([])).toEqual({ boxes: [], height: 0 });
  });
});

describe('thumbnail lazy window', () => {
  const sizes = Array.from({ length: 200 }, () => ({ width: 612, height: 792, rotation: 0 }));
  const { boxes } = thumbnailBoxes(sizes);

  it('asks only for the thumbnails near the top of a long document', () => {
    const range = thumbnailWindow(boxes, 0, 600);
    expect(range.first).toBe(0);
    expect(range.end).toBeGreaterThan(0);
    expect(range.end).toBeLessThan(20);
  });

  it('moves with the scroll position and leaves the far pages out', () => {
    const top = boxes[100]?.top ?? 0;
    const range = thumbnailWindow(boxes, top, 600);
    expect(range.first).toBeGreaterThan(90);
    expect(range.end).toBeLessThan(115);
  });
});

describe('scrollTopForPage', () => {
  const layout = computeColumn(
    [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ],
    1,
  );

  it('puts the page top a page gap below the top of the viewport', () => {
    const top = scrollTopForPage(layout.boxes, 1, 1);
    expect(top).toBeCloseTo((layout.boxes[1]?.top ?? 0) - 12 * (96 / 72));
  });

  it('clamps at zero for the first page and returns null for an unknown page', () => {
    expect(scrollTopForPage(layout.boxes, 0, 1)).toBe(0);
    expect(scrollTopForPage(layout.boxes, 5, 1)).toBeNull();
  });
});
