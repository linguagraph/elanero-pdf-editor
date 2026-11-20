import { describe, expect, it } from 'vitest';
import { computeColumn, computeSpreads, fitPageZoom, fitWidthZoom, largestPage } from './layout';
import { CSS_PX_PER_POINT, MAX_ZOOM, MIN_ZOOM } from './zoom';

// The fit modes (W5.1e) are the zoom at which the layout's content exactly fills the viewport, so
// the tests check the fitted zoom by laying the page out at that zoom and measuring the result.
const LETTER = { width: 612, height: 792 };

describe('fit width', () => {
  it('makes the single column as wide as the viewport at the fitted zoom', () => {
    const zoom = fitWidthZoom(LETTER.width, 1000);
    expect(computeColumn([LETTER], zoom).width).toBeCloseTo(1000, 6);
  });

  it('makes two spreads as wide as the viewport, with three gaps', () => {
    const zoom = fitWidthZoom(LETTER.width, 1000, 2);
    expect(computeSpreads([LETTER, LETTER], zoom, false).width).toBeCloseTo(1000, 6);
  });

  it('is the viewport over the page and its two gaps, in CSS pixels', () => {
    expect(fitWidthZoom(612, 1000)).toBeCloseTo(1000 / (CSS_PX_PER_POINT * (612 + 24)), 12);
  });

  it('clamps to the zoom limits', () => {
    expect(fitWidthZoom(1, 1_000_000)).toBe(MAX_ZOOM);
    expect(fitWidthZoom(1_000_000, 100)).toBe(MIN_ZOOM);
  });

  it('pins the fit to MAX_ZOOM when the fit would be above it, and to MIN_ZOOM below it', () => {
    // A 1 pt wide page in a 1e9 px view fits at about 1e6: far above the limit.
    expect(fitWidthZoom(1, 1e9)).toBe(MAX_ZOOM);
    // A 1e6 pt page in a 10 px view fits at about 1e-5: far below the limit.
    expect(fitWidthZoom(1e6, 10)).toBe(MIN_ZOOM);
    // A fit inside the limits is kept as it is.
    expect(fitWidthZoom(612, 1000)).toBeGreaterThan(MIN_ZOOM);
    expect(fitWidthZoom(612, 1000)).toBeLessThan(MAX_ZOOM);
  });

  it('gives the actual size when the viewport or the page has no size yet', () => {
    expect(fitWidthZoom(612, 0)).toBe(1);
    expect(fitWidthZoom(0, 1000)).toBe(1);
  });
});

describe('fit page', () => {
  it('fits the page height when the page is taller than the viewport allows', () => {
    // 600 px tall: the height fit (600 px over the page and its two gaps) is the smaller one.
    const zoom = fitPageZoom(LETTER.width, LETTER.height, 1000, 600);
    expect(zoom).toBeCloseTo(600 / (CSS_PX_PER_POINT * (792 + 24)), 12);
    expect(computeColumn([LETTER], zoom).height).toBeCloseTo(600, 6);
  });

  it('fits the page width when the viewport is short and wide', () => {
    const zoom = fitPageZoom(LETTER.width, LETTER.height, 400, 5000);
    expect(zoom).toBeCloseTo(fitWidthZoom(LETTER.width, 400), 12);
  });

  it('fits the page in a two-page spread by the spread width', () => {
    const zoom = fitPageZoom(LETTER.width, LETTER.height, 1000, 5000, 2);
    expect(computeSpreads([LETTER, LETTER], zoom, false).width).toBeCloseTo(1000, 6);
  });

  it('clamps to the zoom limits', () => {
    expect(fitPageZoom(1, 1, 1_000_000, 1_000_000)).toBe(MAX_ZOOM);
    expect(fitPageZoom(1_000_000, 1_000_000, 10, 10)).toBe(MIN_ZOOM);
  });
});

describe('largest page', () => {
  it('takes the widest width and the tallest height of the document', () => {
    expect(
      largestPage([
        { width: 612, height: 792 },
        { width: 842, height: 595 },
      ]),
    ).toEqual({ width: 842, height: 792 });
    expect(largestPage([])).toEqual({ width: 0, height: 0 });
  });
});
