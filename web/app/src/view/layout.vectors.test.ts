// The desktop's page layout (core/layout.py) replayed against the shared vectors
// (web/test/vectors/layout.json, made by scripts/make_web_vectors.py). Every case runs here; the
// vector file says which desktop function answered each one.
import { describe, expect, it } from 'vitest';
import rawVectors from '../../../test/vectors/layout.json';
import {
  computeColumn,
  computeSpreads,
  currentPageIndex,
  type PageSizePt,
  scrollTopForPage,
  visibleRange,
} from './layout';
import { CSS_PX_PER_POINT } from './zoom';

type Mode = 'continuous' | 'single' | 'two_up' | 'two_up_cover';

interface VectorCase {
  fn: 'layout' | 'placeholder' | 'scroll_top_for_page' | 'window' | 'current_page';
  set: string;
  mode: Mode;
  zoom: number;
  sizes: number[][];
  index?: number;
  expect?: unknown;
  expect_pt?: number;
  scroll?: number;
  viewport?: number;
}

interface LayoutVectors {
  cases: VectorCase[];
}

const vectors = rawVectors as unknown as LayoutVectors;

function pageSizes(sizes: number[][]): PageSizePt[] {
  return sizes.map(([width, height]) => ({ width: width ?? 0, height: height ?? 0 }));
}

// The layout the web gives for a mode: a single column for continuous and single (the single
// layout is not in the web yet, its column is the same as the continuous one), spreads otherwise.
function layoutFor(c: VectorCase) {
  const sizes = pageSizes(c.sizes);
  if (c.mode === 'two_up') return computeSpreads(sizes, c.zoom, false);
  if (c.mode === 'two_up_cover') return computeSpreads(sizes, c.zoom, true);
  return computeColumn(sizes, c.zoom);
}

// CSS pixels to visible points at the case's zoom (the inverse of the view's scale).
function toPt(px: number, zoom: number): number {
  return px / (zoom * CSS_PX_PER_POINT);
}

function cases(fn: VectorCase['fn']): [string, VectorCase][] {
  return vectors.cases
    .filter((c) => c.fn === fn)
    .map((c, i) => [`${c.set} ${c.mode} z${c.zoom} #${i}`, c]);
}

describe('layout vectors: page boxes (compute_layout, layout_bounds)', () => {
  it.each(cases('layout'))('%s', (_name, c) => {
    const layout = layoutFor(c);
    const expected = c.expect as {
      boxes: number[][];
      width: number;
      height: number;
    };
    expect(layout.boxes.map((b) => b.index)).toEqual(expected.boxes.map((_, i) => i));
    layout.boxes.forEach((box, i) => {
      const [x0, y0, x1, y1] = expected.boxes[i] ?? [];
      expect(toPt(box.left, c.zoom)).toBeCloseTo(x0 ?? NaN, 6);
      expect(toPt(box.top, c.zoom)).toBeCloseTo(y0 ?? NaN, 6);
      expect(toPt(box.left + box.width, c.zoom)).toBeCloseTo(x1 ?? NaN, 6);
      expect(toPt(box.top + box.height, c.zoom)).toBeCloseTo(y1 ?? NaN, 6);
    });
    expect(toPt(layout.width, c.zoom)).toBeCloseTo(expected.width, 6);
    expect(toPt(layout.height, c.zoom)).toBeCloseTo(expected.height, 6);
  });
});

describe('layout vectors: placeholder sizes', () => {
  it.each(cases('placeholder'))('%s', (_name, c) => {
    const box = layoutFor(c).boxes[c.index ?? -1];
    const [width, height] = c.expect as number[];
    expect(box).toBeDefined();
    expect(toPt(box?.width ?? NaN, c.zoom)).toBeCloseTo(width ?? NaN, 6);
    expect(toPt(box?.height ?? NaN, c.zoom)).toBeCloseTo(height ?? NaN, 6);
  });
});

describe('layout vectors: scroll position for a page', () => {
  it.each(cases('scroll_top_for_page'))('%s', (_name, c) => {
    const layout = layoutFor(c);
    const index = c.index ?? -1;
    // Every layout aims at the page's own top, half a gap above it (go_to_page), spreads included.
    const scroll = scrollTopForPage(layout.boxes, index, c.zoom);
    expect(scroll).not.toBeNull();
    expect(toPt(scroll ?? NaN, c.zoom)).toBeCloseTo(c.expect_pt ?? NaN, 6);
  });
});

describe('layout vectors: mounting window', () => {
  it.each(cases('window'))('%s', (_name, c) => {
    const layout = layoutFor(c);
    expect(visibleRange(layout.boxes, c.scroll ?? 0, c.viewport ?? 0)).toEqual(c.expect);
  });
});

describe('layout vectors: current page', () => {
  it.each(cases('current_page'))('%s', (_name, c) => {
    const layout = layoutFor(c);
    expect(currentPageIndex(layout.boxes, c.scroll ?? 0, c.viewport ?? 0)).toBe(c.expect);
  });
});
