// The bookmark's place in the view (W5.2 S3): the page and the viewport's top within it, as a
// fraction of the page's box, so it is the same at every zoom.
import { describe, expect, it } from 'vitest';
import { type PageBox, viewLocation } from './layout';

// Two pages of 800 pt, drawn 1000 CSS px tall with a 20 px gap: page 0 at 0, page 1 at 1020.
const BOXES: PageBox[] = [
  { index: 0, top: 0, left: 0, width: 600, height: 1000 },
  { index: 1, top: 1020, left: 0, width: 600, height: 1000 },
];
const HEIGHT_PT = 800;

describe('viewLocation', () => {
  it('reads the top of the viewport as points below the page top', () => {
    // 250 px below page 1's top is a quarter of its height: 200 pt.
    expect(viewLocation(BOXES, HEIGHT_PT, 1, 1020 + 250)).toEqual({ page: 1, top: 200 });
  });

  it('gives the same fraction at another zoom (a box twice the size)', () => {
    const zoomed = BOXES.map((box) => ({ ...box, top: box.top * 2, height: box.height * 2 }));
    expect(viewLocation(zoomed, HEIGHT_PT, 1, 2040 + 500)).toEqual({ page: 1, top: 200 });
  });

  it('is the page top when the viewport top is above the page', () => {
    expect(viewLocation(BOXES, HEIGHT_PT, 1, 1000)).toEqual({ page: 1, top: null });
  });

  it('is the page top when the viewport is less than a point below it', () => {
    // 1 CSS px is 0.8 pt on this page: under a point, so the page top.
    expect(viewLocation(BOXES, HEIGHT_PT, 0, 1)).toEqual({ page: 0, top: null });
  });

  it('is clamped to the page height past its bottom', () => {
    expect(viewLocation(BOXES, HEIGHT_PT, 0, 5000)).toEqual({ page: 0, top: 800 });
  });

  it('is null for a page that is not laid out', () => {
    expect(viewLocation(BOXES, HEIGHT_PT, 9, 100)).toBeNull();
  });

  it('is null for a scroll position that is not a number or not finite', () => {
    expect(viewLocation(BOXES, HEIGHT_PT, 1, Number.NaN)).toBeNull();
    expect(viewLocation(BOXES, HEIGHT_PT, 1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rounds to 0.01 point', () => {
    const top = viewLocation(BOXES, HEIGHT_PT, 0, 123.456)?.top;
    // 123.456 px of 1000 px is 0.123456 of 800 pt: 98.7648, which rounds to 98.76.
    expect(top).toBe(98.76);
  });
});
