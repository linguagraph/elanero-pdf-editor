import { describe, expect, it } from 'vitest';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { cssBox, cssToPoints, pagePointAt, pointsToCss, rectBetween } from './coordinates';

describe('page coordinates', () => {
  it('maps CSS pixels to points at a zoom and back', () => {
    for (const zoom of [0.1, 0.5, 1, 2.5, 64]) {
      for (const px of [0, 1, 37.5, 480]) {
        expect(pointsToCss(cssToPoints(px, zoom), zoom)).toBeCloseTo(px, 9);
      }
    }
  });

  it('is 72 points per inch at zoom 1, so 96 CSS pixels make 72 points', () => {
    expect(cssToPoints(96, 1)).toBeCloseTo(72, 9);
    expect(cssToPoints(CSS_PX_PER_POINT * 10, 1)).toBeCloseTo(10, 9);
    expect(cssToPoints(96, 2)).toBeCloseTo(36, 9);
  });

  it('keeps a point on the page', () => {
    expect(pagePointAt(-5, 9999, 1, 612, 792)).toEqual({ x: 0, y: 792 });
    const inside = pagePointAt(96, 192, 1, 612, 792);
    expect(inside.x).toBeCloseTo(72, 9);
    expect(inside.y).toBeCloseTo(144, 9);
  });

  it('normalizes a drag from any corner', () => {
    expect(rectBetween({ x: 50, y: 10 }, { x: 20, y: 40 })).toEqual({
      x0: 20,
      y0: 10,
      x1: 50,
      y1: 40,
    });
  });

  it('gives the CSS box of a page rect at the zoom', () => {
    expect(cssBox({ x0: 72, y0: 72, x1: 144, y1: 144 }, 1)).toEqual({
      left: 96,
      top: 96,
      width: 96,
      height: 96,
    });
  });
});
