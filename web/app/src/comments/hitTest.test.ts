import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RectDto } from '../rpc/generated';
import { type CommentRef, commentAt, nextCommentSelection, pruneCommentSelection } from './hitTest';

// The shared vectors the desktop's annotation_at answers were recorded into (edit_geometry.comment_at).
interface Vectors {
  comment_at: {
    boxes: [number[], boolean][];
    point: number[];
    tol: number;
    expected: number | null;
  }[];
}

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
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as Vectors;

function rect(a: number[]): RectDto {
  const [x0, y0, x1, y1] = a as [number, number, number, number];
  return { x0, y0, x1, y1 };
}

describe('commentAt', () => {
  it('agrees with the desktop on every shared vector', () => {
    for (const vector of vectors.comment_at) {
      const threads = vector.boxes.map(([box, hidden], index) => ({
        index,
        comment: { bounds: rect(box), hidden },
      }));
      const hit = commentAt(
        threads,
        { x: vector.point[0] ?? 0, y: vector.point[1] ?? 0 },
        vector.tol,
      );
      expect(hit?.index ?? null).toBe(vector.expected);
    }
  });

  it('takes the last visible thread under the point and skips hidden ones', () => {
    const under = { x: 5, y: 5 };
    const threads = [
      { id: 'a', comment: { bounds: { x0: 0, y0: 0, x1: 10, y1: 10 }, hidden: false } },
      { id: 'b', comment: { bounds: { x0: 0, y0: 0, x1: 10, y1: 10 }, hidden: true } },
    ];
    expect(commentAt(threads, under, 0)?.id).toBe('a');
    expect(commentAt(threads, { x: 50, y: 50 }, 0)).toBeNull();
  });
});

describe('the comment selection', () => {
  const a: CommentRef = { page: 0, name: 'a' };
  const b: CommentRef = { page: 1, name: 'b' };

  it('a plain press selects only that comment; Ctrl toggles it within the selection', () => {
    expect(nextCommentSelection([b], a, false)).toEqual([a]);
    expect(nextCommentSelection([a], b, true)).toEqual([a, b]);
    expect(nextCommentSelection([a, b], a, true)).toEqual([b]);
  });

  it('prunes only the page it is told about', () => {
    expect(pruneCommentSelection([a, b], 0, new Set())).toEqual([b]);
    expect(pruneCommentSelection([a, b], 1, new Set(['a']))).toEqual([a]);
  });
});
