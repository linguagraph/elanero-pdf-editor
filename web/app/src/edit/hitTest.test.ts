import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RectDto } from '../rpc/generated';
import {
  fitMatrix,
  handleAt,
  handlePoints,
  type Hittable,
  isClick,
  objectAt,
  objectsIn,
  type Point,
  reselect,
  resizeBox,
} from './hitTest';

// The shared vectors the desktop's edit_geometry answers were recorded into (W6.7a S2). Both sides
// must agree on every one of them.
interface Vectors {
  constants: { HANDLE_PX: number; MIN_DRAG: number; MIN_SIZE: number; OBJECT_TOL_PX: number };
  fit_matrix: { old: number[]; new: number[]; expected: number[] }[];
  handle_at: { box: number[]; point: number[]; tol: number; expected: number | null }[];
  handle_points: { box: number[]; expected: number[][] }[];
  is_click: { a: number[]; b: number[]; expected: boolean }[];
  object_at: { point: number[]; tol: number; expected: string | null }[];
  objects: { bbox: number[]; key: string }[];
  objects_in: { box: number[]; expected: string[] }[];
  reselect: { boxes: number[][]; expected: string[] }[];
  resize_box: { box: number[]; handle: number; point: number[]; expected: number[] }[];
}

// web/app/src/edit -> web/src/tools/vectors: the vectors live beside the web app, not inside it.
const vectorsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'tools',
  'vectors',
  'edit-geometry.json',
);

const vectors: Vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;

function rect(a: number[]): RectDto {
  const [x0, y0, x1, y1] = a as [number, number, number, number];
  return { x0, y0, x1, y1 };
}

function point(a: number[]): Point {
  const [x, y] = a as [number, number];
  return { x, y };
}

const objects: Hittable[] = vectors.objects.map((o) => ({ key: o.key, bbox: rect(o.bbox) }));

describe('shared edit-geometry vectors', () => {
  it('pins the constants the web uses to the desktop values', () => {
    expect(vectors.constants.HANDLE_PX).toBe(6);
    expect(vectors.constants.OBJECT_TOL_PX).toBe(2);
    expect(vectors.constants.MIN_DRAG).toBe(3);
    expect(vectors.constants.MIN_SIZE).toBe(4);
  });

  it('handle_points matches every vector', () => {
    for (const v of vectors.handle_points) {
      const got = handlePoints(rect(v.box)).map((p) => [p.x, p.y]);
      expect(got).toEqual(v.expected);
    }
  });

  it('handle_at matches every vector', () => {
    for (const v of vectors.handle_at) {
      expect(handleAt(rect(v.box), point(v.point), v.tol)).toBe(v.expected);
    }
  });

  it('fit_matrix matches every vector', () => {
    for (const v of vectors.fit_matrix) {
      const got = fitMatrix(rect(v.old), rect(v.new));
      got.forEach((n, i) => expect(n).toBeCloseTo(v.expected[i] ?? NaN, 9));
    }
  });

  it('resize_box matches every vector', () => {
    for (const v of vectors.resize_box) {
      const got = resizeBox(rect(v.box), v.handle, point(v.point));
      expect([got.x0, got.y0, got.x1, got.y1]).toEqual(v.expected);
    }
  });

  it('is_click matches every vector', () => {
    for (const v of vectors.is_click) {
      expect(isClick(point(v.a), point(v.b))).toBe(v.expected);
    }
  });

  it('object_at picks the same object as the desktop for every vector', () => {
    for (const v of vectors.object_at) {
      const hit = objectAt(objects, point(v.point), v.tol);
      expect(hit?.key ?? null).toBe(v.expected);
    }
  });

  it('objects_in matches every vector, in list order', () => {
    for (const v of vectors.objects_in) {
      const keys = objectsIn(objects, rect(v.box)).map((o) => o.key);
      expect(keys).toEqual(v.expected);
    }
  });

  it('reselect matches every vector', () => {
    for (const v of vectors.reselect) {
      expect(reselect(objects, v.boxes.map(rect))).toEqual(v.expected);
    }
  });
});

describe('objectAt', () => {
  it('returns null on empty ground', () => {
    expect(objectAt(objects, { x: 300, y: 300 }, 0)).toBeNull();
  });
});

describe('resizeBox', () => {
  it('floors a dragged edge at the minimum size instead of inverting the box', () => {
    const box = { x0: 0, y0: 0, x1: 100, y1: 50 };
    const got = resizeBox(box, 2, { x: -20, y: 0 });
    expect(got).toEqual({ x0: 0, y0: 0, x1: 4, y1: 50 });
  });
});
