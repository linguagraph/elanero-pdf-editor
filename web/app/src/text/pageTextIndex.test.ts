// The desktop's text model replayed against the shared vectors (web/test/vectors/text.json, made by
// scripts/make_web_vectors.py from services/text.py). Every case that is not a search runs here;
// the search cases are replayed with the search panel (W5.4 S5).
import { describe, expect, it } from 'vitest';
import rawVectors from '../../../test/vectors/text.json';
import { PageTextIndex, isWordChar } from './pageTextIndex';
import { TextSelection, type PageIndexes } from './textSelection';

interface VectorLayer {
  text: string;
  line_rects: number[][];
  char_boxes: number[];
  line_numbers: number[];
}

interface VectorCase {
  fn: string;
  args: Record<string, unknown>;
  expect: unknown;
  layer?: string;
  layers?: string[];
}

interface VectorFile {
  constants: { HIT_TOLERANCE: number; LINE_SEP: string };
  layers: Record<string, VectorLayer>;
  cases: VectorCase[];
}

const vectors = rawVectors as unknown as VectorFile;

// The vectors' floats are the desktop's values, rounded to 3 places: a 1e-6 tolerance is exact
// enough, and the index's own numbers are doubles, so nothing is lost on the way.
const FLOAT_TOLERANCE = 1e-6;

function indexFor(name: string): PageTextIndex {
  const layer = vectors.layers[name];
  if (layer === undefined) throw new Error(`no layer ${name} in the vectors`);
  return new PageTextIndex({
    text: layer.text,
    lineRects: layer.line_rects.map(([x0, y0, x1, y1]) => ({
      x0: x0 ?? 0,
      y0: y0 ?? 0,
      x1: x1 ?? 0,
      y1: y1 ?? 0,
    })),
    charBoxes: layer.char_boxes,
    lineNumbers: layer.line_numbers,
  });
}

// Pages by number: page k is the k-th layer named in the case.
function pagesOf(names: readonly string[]): PageIndexes {
  const indexes = names.map(indexFor);
  return {
    get(page: number): PageTextIndex {
      const index = indexes[page];
      if (index === undefined) throw new Error(`no page ${page}`);
      return index;
    },
  };
}

// Compares two values the way the vectors are written: floats within the tolerance, everything
// else exactly. The path names the first difference.
function expectSame(actual: unknown, expected: unknown, path = 'result'): void {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number');
    expect(Math.abs((actual as number) - expected), path).toBeLessThanOrEqual(FLOAT_TOLERANCE);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    const got = actual as unknown[];
    expect(got.length, `${path}.length`).toBe(expected.length);
    expected.forEach((item, i) => expectSame(got[i], item, `${path}[${i}]`));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    const want = expected as Record<string, unknown>;
    const got = actual as Record<string, unknown>;
    expect(Object.keys(got).sort(), `${path} keys`).toEqual(Object.keys(want).sort());
    for (const key of Object.keys(want)) expectSame(got[key], want[key], `${path}.${key}`);
    return;
  }
  expect(actual, path).toBe(expected);
}

const boxArray = (r: { x0: number; y0: number; x1: number; y1: number }) => [
  r.x0,
  r.y0,
  r.x1,
  r.y1,
];

// Runs one index case through the port and returns its result in the vectors' shape.
function runCase(c: VectorCase): unknown {
  const args = c.args;
  if (c.fn === 'is_word_char') return isWordChar(args.c as string);
  if (c.fn === 'selection') {
    const names = c.layers ?? [];
    const pages = pagesOf(names);
    const [ap, ai] = args.anchor as number[];
    const [fp, fi] = args.focus as number[];
    const sel = new TextSelection(
      { page: ap ?? 0, index: ai ?? 0 },
      { page: fp ?? 0, index: fi ?? 0 },
    );
    const pageRects: Record<string, number[][]> = {};
    for (const [page, rects] of sel.rects(pages)) {
      pageRects[String(page)] = rects.map(boxArray);
    }
    return {
      page_spans: sel.pageSpans(pages).map((s) => [s.page, s.start, s.end]),
      page_rects: pageRects,
      text: sel.text(pages),
    };
  }
  const index = indexFor(c.layer ?? '');
  const p = args.p as number[];
  switch (c.fn) {
    case 'hit_test':
      return index.hitTest({ x: p[0] ?? 0, y: p[1] ?? 0 }, args.tolerance as number);
    case 'nearest':
      return index.nearest({ x: p[0] ?? 0, y: p[1] ?? 0 });
    case 'word_range':
      return [...index.wordRange(args.i as number)];
    case 'line_range':
      return [...index.lineRange(args.i as number)];
    case 'rects':
      return index.rects(args.start as number, args.end as number).map(boxArray);
    case 'extract':
      return index.extract(args.start as number, args.end as number);
    default:
      throw new Error(`unknown vector function ${c.fn}`);
  }
}

// The vectors' cases the port replays. Search (S5) is not one of them.
const REPLAYED = new Set([
  'hit_test',
  'nearest',
  'word_range',
  'line_range',
  'rects',
  'extract',
  'selection',
  'is_word_char',
]);

describe('text model against the shared vectors', () => {
  it('uses the desktop constants', () => {
    expect(vectors.constants.HIT_TOLERANCE).toBe(4);
    expect(vectors.constants.LINE_SEP).toBe('\n');
  });

  it('replays every non-search case', () => {
    const searches = vectors.cases.filter((c) => c.fn === 'search').length;
    expect(vectors.cases.filter((c) => REPLAYED.has(c.fn)).length).toBe(
      vectors.cases.length - searches,
    );
  });

  // One test per case, so a failure names the function, the layer and the arguments.
  const cases = vectors.cases.filter((c) => REPLAYED.has(c.fn));
  it.each(cases.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    expectSame(runCase(c), c.expect);
  });
});

// A two-line page with boxes that are easy to check by hand: "ab" over "cd", each char 10 wide.
const TWO_LINES = new PageTextIndex({
  text: 'ab\ncd',
  lineRects: [
    { x0: 0, y0: 0, x1: 20, y1: 10 },
    { x0: 0, y0: 12, x1: 20, y1: 22 },
  ],
  charBoxes: [0, 0, 10, 10, 10, 0, 20, 10, 0, 0, 0, 0, 0, 12, 10, 22, 10, 12, 20, 22],
  lineNumbers: [0, 0, 0, 1, 1],
});

describe('PageTextIndex', () => {
  it('counts code points, so an astral char is one offset', () => {
    const index = new PageTextIndex({
      text: 'a\u{1F600}b',
      lineRects: [{ x0: 0, y0: 0, x1: 30, y1: 10 }],
      charBoxes: [0, 0, 10, 10, 10, 0, 20, 10, 20, 0, 30, 10],
      lineNumbers: [0, 0, 0],
    });
    expect(index.length).toBe(3);
    expect(index.extract(1, 2)).toBe('\u{1F600}');
    expect(index.wordRange(1)).toEqual([1, 2]);
  });

  it('places the caret on the side of a char it is on', () => {
    expect(TWO_LINES.hitTest({ x: 4, y: 5 })).toBe(0);
    expect(TWO_LINES.hitTest({ x: 15, y: 5 })).toBe(2);
    expect(TWO_LINES.hitTest({ x: 500, y: 5 })).toBeNull();
  });

  it('never gives up in nearest, and puts a caret past the line end', () => {
    expect(TWO_LINES.nearest({ x: 25, y: 17 })).toBe(5);
    expect(TWO_LINES.nearest({ x: -50, y: 1 })).toBe(0);
  });

  it('gives one rectangle per line, and skips separators', () => {
    expect(TWO_LINES.rects(0, 5)).toEqual([
      { x0: 0, y0: 0, x1: 20, y1: 10 },
      { x0: 0, y0: 12, x1: 20, y1: 22 },
    ]);
    expect(TWO_LINES.rects(2, 3)).toEqual([]);
  });

  it('clamps ranges and handles an empty page', () => {
    const empty = new PageTextIndex({ text: '', lineRects: [], charBoxes: [], lineNumbers: [] });
    expect(empty.length).toBe(0);
    expect(empty.hitTest({ x: 0, y: 0 })).toBeNull();
    expect(empty.nearest({ x: 0, y: 0 })).toBeNull();
    expect(empty.wordRange(3)).toEqual([0, 0]);
    expect(empty.lineRange(3)).toEqual([0, 0]);
    expect(empty.rects(0, 10)).toEqual([]);
    expect(TWO_LINES.lineRange(99)).toEqual([3, 5]);
    expect(TWO_LINES.extract(-4, 2)).toBe('ab');
  });

  it('reads the wire layer, whose boxes are Float32', () => {
    const index = PageTextIndex.fromLayer({
      text: 'ab',
      line_rects: [{ x0: 0, y0: 0, x1: 20, y1: 10 }],
      char_boxes: new Float32Array([0, 0, 10, 10, 10, 0, 20, 10]).buffer,
      line_numbers: new Uint32Array([0, 0]).buffer,
    });
    expect(index.hitTest({ x: 16, y: 5 })).toBe(2);
    expect(index.extract(0, 2)).toBe('ab');
  });
});

describe('TextSelection', () => {
  const pages: PageIndexes = { get: () => TWO_LINES };

  it('reads a reversed drag the same as a forward one', () => {
    const forward = new TextSelection({ page: 0, index: 0 }, { page: 0, index: 5 });
    const backward = new TextSelection({ page: 0, index: 5 }, { page: 0, index: 0 });
    expect(backward.text(pages)).toBe('ab\ncd');
    expect(backward.pageSpans(pages)).toEqual(forward.pageSpans(pages));
  });

  it('is empty when anchor and focus meet', () => {
    const sel = new TextSelection({ page: 0, index: 2 }, { page: 0, index: 2 });
    expect(sel.isEmpty).toBe(true);
    expect(sel.pageSpans(pages)).toEqual([]);
    expect(sel.text(pages)).toBe('');
    expect(sel.covers(0)).toBe(false);
  });
});
