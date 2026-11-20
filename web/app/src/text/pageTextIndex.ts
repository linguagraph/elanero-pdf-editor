// The character index of one page (W5.4, W1.4 section 10): a TypeScript port of the desktop's
// services/text.py PageTextIndex. The chars are the layer's code points in reading order, so an
// offset here is the engine's offset; the hit test, the word and line ranges and the selection
// rectangles follow the desktop's rules, and web/test/vectors/text.json pins them case by case.
import type { AreaPoint, AreaRect, SplitTextLayer } from './textLayer';

// The separator the engine puts between lines (services/text.py LINE_SEP).
export const LINE_SEP = '\n';

// The desktop's hit tolerance, in points (services/text.py hit_test).
export const HIT_TOLERANCE = 4;

// The layer's data as plain numbers. The wire layer and the test vectors both reduce to this.
export interface PageIndexSource {
  readonly text: string;
  readonly lineRects: readonly AreaRect[];
  // Four numbers per char (x0, y0, x1, y1); zeros for a separator or a char without a box.
  readonly charBoxes: ArrayLike<number>;
  // The line each char belongs to, an index into lineRects.
  readonly lineNumbers: ArrayLike<number>;
}

// Whether a char is part of a word (services/text.py _is_word_char): letters, numbers, the
// underscore and combining marks. The Python rule is str.isalnum(); \p{L} and \p{N} match it,
// and the vectors pin the samples where they could differ.
export function isWordChar(c: string): boolean {
  return c === '_' || /[\p{L}\p{N}]/u.test(c) || /\p{Mn}/u.test(c);
}

export class PageTextIndex {
  readonly text: string;
  readonly lineRects: readonly AreaRect[];
  // The chars, one entry per code point. chars[i] is what text's i-th code point is.
  private readonly chars: readonly string[];
  // Four numbers per char, the char's box in points.
  private readonly boxes: Float64Array;
  private readonly lineOf: Uint32Array;
  // The chars of each line, other than separators, in order.
  private readonly lineChars = new Map<number, number[]>();

  constructor(source: PageIndexSource) {
    this.text = source.text;
    this.lineRects = source.lineRects;
    this.chars = Array.from(source.text);
    const count = this.chars.length;
    this.boxes = new Float64Array(count * 4);
    const boxCount = Math.min(count, Math.floor(source.charBoxes.length / 4));
    for (let i = 0; i < boxCount * 4; i += 1) this.boxes[i] = source.charBoxes[i] ?? 0;
    this.lineOf = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) this.lineOf[i] = source.lineNumbers[i] ?? 0;
    for (let i = 0; i < count; i += 1) {
      if (this.chars[i] === LINE_SEP) continue;
      const line = this.lineOf[i] ?? 0;
      const known = this.lineChars.get(line);
      if (known === undefined) this.lineChars.set(line, [i]);
      else known.push(i);
    }
  }

  // The index of a layer the engine answered (text.layer).
  static fromLayer(
    layer: Pick<SplitTextLayer, 'text' | 'line_rects' | 'char_boxes' | 'line_numbers'>,
  ): PageTextIndex {
    return new PageTextIndex({
      text: layer.text,
      lineRects: layer.line_rects.map((r) => ({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 })),
      charBoxes: new Float32Array(layer.char_boxes),
      lineNumbers: new Uint32Array(layer.line_numbers),
    });
  }

  // The number of chars (code points), the unit every offset here uses.
  get length(): number {
    return this.chars.length;
  }

  // The caret index nearest to p if p is on a line, or within the tolerance of one; else null.
  hitTest(p: AreaPoint, tolerance: number = HIT_TOLERANCE): number | null {
    // The vertically closest line wins; on a tie the earlier line does, as the desktop's min does.
    let line: number | null = null;
    let distance = Infinity;
    for (let i = 0; i < this.lineRects.length; i += 1) {
      const rect = this.lineRects[i];
      if (rect === undefined || boxGap(rect, p) > tolerance) continue;
      const d = lineDistance(rect, p);
      if (line === null || d < distance) {
        line = i;
        distance = d;
      }
    }
    return line === null ? null : this.caretOnLine(line, p);
  }

  // Like hitTest, but never gives up: used while a drag runs. Null only when there are no lines.
  nearest(p: AreaPoint): number | null {
    let line: number | null = null;
    let distance = Infinity;
    for (let i = 0; i < this.lineRects.length; i += 1) {
      const rect = this.lineRects[i];
      if (rect === undefined || !this.lineChars.has(i)) continue;
      const d = lineDistance(rect, p);
      if (line === null || d < distance) {
        line = i;
        distance = d;
      }
    }
    return line === null ? null : this.caretOnLine(line, p);
  }

  // The char range [start, end) of the word at index i (a non-word char is its own range).
  wordRange(i: number): [number, number] {
    if (this.chars.length === 0) return [0, 0];
    const at = clamp(i, 0, this.chars.length - 1);
    if (!isWordChar(this.chars[at] ?? '')) return [at, at + 1];
    let start = at;
    while (start > 0 && isWordChar(this.chars[start - 1] ?? '')) start -= 1;
    let end = at + 1;
    while (end < this.chars.length && isWordChar(this.chars[end] ?? '')) end += 1;
    return [start, end];
  }

  // The char range [start, end) of the line that holds index i, separators excluded.
  lineRange(i: number): [number, number] {
    if (this.chars.length === 0) return [0, 0];
    const at = clamp(i, 0, this.chars.length - 1);
    const line = this.lineChars.get(this.lineOf[at] ?? 0);
    if (line === undefined || line.length === 0) return [at, at + 1];
    return [line[0] ?? at, (line[line.length - 1] ?? at) + 1];
  }

  // One rectangle per line that the chars [start, end) touch: the union of their boxes. Separators
  // and chars without a box are skipped.
  rects(start: number, end: number): AreaRect[] {
    const out: AreaRect[] = [];
    let current: AreaRect | null = null;
    let currentLine = -1;
    const stop = Math.min(this.chars.length, Math.max(0, end));
    for (let i = Math.max(0, start); i < stop; i += 1) {
      if (this.chars[i] === LINE_SEP) continue;
      const box = this.boxAt(i);
      if (isEmptyRect(box)) continue;
      const line = this.lineOf[i] ?? 0;
      if (current === null || line !== currentLine) {
        if (current !== null) out.push(current);
        current = box;
        currentLine = line;
      } else {
        current = unionRect(current, box);
      }
    }
    if (current !== null) out.push(current);
    return out;
  }

  // The text of the chars [start, end), clamped to the index.
  extract(start: number, end: number): string {
    return this.chars.slice(Math.max(0, start), Math.max(0, end)).join('');
  }

  private boxAt(i: number): AreaRect {
    return {
      x0: this.boxes[i * 4] ?? 0,
      y0: this.boxes[i * 4 + 1] ?? 0,
      x1: this.boxes[i * 4 + 2] ?? 0,
      y1: this.boxes[i * 4 + 3] ?? 0,
    };
  }

  // The caret on one line nearest to p: left of a char's midpoint is before it, right of it after.
  private caretOnLine(line: number, p: AreaPoint): number | null {
    const candidates = this.lineChars.get(line);
    if (candidates === undefined || candidates.length === 0) return null;
    for (const i of candidates) {
      const b = this.boxAt(i);
      if (b.x0 <= p.x && p.x <= b.x1) return p.x < (b.x0 + b.x1) / 2 ? i : i + 1;
    }
    const first = candidates[0] ?? 0;
    const last = candidates[candidates.length - 1] ?? 0;
    if (p.x < this.boxAt(first).x0) return first;
    if (p.x > this.boxAt(last).x1) return last + 1;
    let nearest = first;
    let gap = Infinity;
    for (const i of candidates) {
      const b = this.boxAt(i);
      const d = Math.abs((b.x0 + b.x1) / 2 - p.x);
      if (d < gap) {
        gap = d;
        nearest = i;
      }
    }
    return nearest;
  }
}

// The distance from p to the nearest edge of a line box, along x and y. The vertical part counts
// four times, so the vertically closest line wins (services/text.py _box_gap / _distance).
function boxGap(r: AreaRect, p: AreaPoint): number {
  return Math.max(r.x0 - p.x, 0, p.x - r.x1, r.y0 - p.y, p.y - r.y1);
}

function lineDistance(r: AreaRect, p: AreaPoint): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dy = Math.max(r.y0 - p.y, 0, p.y - r.y1);
  return dy * 4 + dx;
}

function isEmptyRect(r: AreaRect): boolean {
  return r.x1 <= r.x0 || r.y1 <= r.y0;
}

function unionRect(a: AreaRect, b: AreaRect): AreaRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
