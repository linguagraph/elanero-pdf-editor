import { describe, expect, it } from 'vitest';
import { decodeTextLayer, placeLines, selectionAreas } from './textLayer';

// Five chars: "ab", a line separator, "cd". The separator has a zero box, as the engine gives it.
const TEXT = 'ab\ncd';
const BOXES = new Float32Array([
  10,
  20,
  20,
  30, // a
  20,
  20,
  30,
  30, // b
  0,
  0,
  0,
  0, // separator
  10,
  40,
  20,
  52, // c
  20,
  40,
  31,
  52, // d
]).buffer;
const NUMBERS = new Uint32Array([0, 0, 0, 1, 1]).buffer;

describe('decodeTextLayer', () => {
  it('groups the chars into lines with the union of their boxes, in points', () => {
    expect(decodeTextLayer({ text: TEXT, char_boxes: BOXES, line_numbers: NUMBERS })).toMatchObject(
      [
        { text: 'ab', x0: 10, y0: 20, x1: 30, y1: 30 },
        { text: 'cd', x0: 10, y0: 40, x1: 31, y1: 52 },
      ],
    );
  });

  it('gives each line its start code point and a view on its own char boxes', () => {
    const [first, second] = decodeTextLayer({
      text: TEXT,
      char_boxes: BOXES,
      line_numbers: NUMBERS,
    });
    // "ab" starts at 0; the separator is index 2, so "cd" starts at 3 (the engine's index).
    expect(first?.start).toBe(0);
    expect(second?.start).toBe(3);
    expect(Array.from(first?.chars ?? [])).toEqual([10, 20, 20, 30, 20, 20, 30, 30]);
    expect(Array.from(second?.chars ?? [])).toEqual([10, 40, 20, 52, 20, 40, 31, 52]);
    // A view, not a copy: the chars share the layer's buffer.
    expect(first?.chars.buffer).toBe(BOXES);
  });

  it('keeps one box per code point for a surrogate pair', () => {
    const [line] = decodeTextLayer({
      text: '𝔸b',
      char_boxes: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]).buffer,
      line_numbers: new Uint32Array([0, 0]).buffer,
    });
    expect(line?.chars.length).toBe(8);
    expect(Array.from(line?.chars.subarray(4) ?? [])).toEqual([3, 3, 4, 4]);
  });

  it('starts a new line where the line number changes, even without a separator', () => {
    const lines = decodeTextLayer({
      text: 'ab',
      char_boxes: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]).buffer,
      line_numbers: new Uint32Array([0, 1]).buffer,
    });
    expect(lines.map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('counts chars as code points, the engine index', () => {
    const lines = decodeTextLayer({
      text: '𝔸b',
      char_boxes: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]).buffer,
      line_numbers: new Uint32Array([0, 0]).buffer,
    });
    expect(lines).toMatchObject([{ text: '𝔸b', x0: 1, y0: 1, x1: 4, y1: 4 }]);
  });

  it('leaves out a line with no geometry', () => {
    const lines = decodeTextLayer({
      text: 'ab',
      char_boxes: new Float32Array(8).buffer,
      line_numbers: new Uint32Array([0, 0]).buffer,
    });
    expect(lines).toEqual([]);
  });
});

describe('selectionAreas', () => {
  const lines = decodeTextLayer({ text: TEXT, char_boxes: BOXES, line_numbers: NUMBERS });

  it('marks only the selected chars of a partly selected line', () => {
    // Code point 1 is "b" on line one.
    expect(selectionAreas(lines, 0, 1, 2)).toEqual({
      page: 0,
      rect: { x0: 20, y0: 20, x1: 30, y1: 30 },
      quads: [
        {
          ul: { x: 20, y: 20 },
          ur: { x: 30, y: 20 },
          ll: { x: 20, y: 30 },
          lr: { x: 30, y: 30 },
        },
      ],
      text: 'b',
    });
  });

  it('gives one quad per line, and a rect that is the union of the lines', () => {
    const area = selectionAreas(lines, 0, 0, 5);
    expect(area?.rect).toEqual({ x0: 10, y0: 20, x1: 31, y1: 52 });
    expect(area?.quads).toHaveLength(2);
    expect(area?.quads[1]?.lr).toEqual({ x: 31, y: 52 });
    expect(area?.text).toBe('ab\ncd');
  });

  it('spans the lines of a selection that starts on one line and ends on the next', () => {
    // From "b" (cp 1) to "c" (cp 3), with cp 2 the separator.
    const area = selectionAreas(lines, 0, 1, 4);
    expect(area?.rect).toEqual({ x0: 10, y0: 20, x1: 30, y1: 52 });
    expect(area?.text).toBe('b\nc');
  });

  it('skips zero boxes, so they do not stretch the union to the origin', () => {
    const [line] = decodeTextLayer({
      text: 'abc',
      char_boxes: new Float32Array([1, 1, 2, 2, 0, 0, 0, 0, 3, 3, 4, 4]).buffer,
      line_numbers: new Uint32Array([0, 0, 0]).buffer,
    });
    const area = selectionAreas(line ? [line] : [], 0, 0, 3);
    expect(area?.rect).toEqual({ x0: 1, y0: 1, x1: 4, y1: 4 });
    expect(area?.quads).toHaveLength(1);
    expect(area?.text).toBe('abc');
  });

  it('gives null for a selection outside the layer or with no boxes', () => {
    expect(selectionAreas(lines, 0, 10, 20)).toBeNull();
    expect(selectionAreas(lines, 0, 2, 3)).toBeNull();
    expect(selectionAreas([], 0, 0, 5)).toBeNull();
  });
});

describe('placeLines', () => {
  const lines = decodeTextLayer({ text: TEXT, char_boxes: BOXES, line_numbers: NUMBERS });

  it('places a line at its point box times the zoom and 96/72 CSS pixels per point', () => {
    const [first] = placeLines(lines, 1);
    expect(first).toEqual({
      text: 'ab',
      left: 10 * (96 / 72),
      top: 20 * (96 / 72),
      width: 20 * (96 / 72),
      height: 10 * (96 / 72),
    });
  });

  it('scales every position with the zoom', () => {
    const [, second] = placeLines(lines, 2);
    expect(second).toEqual({
      text: 'cd',
      left: 20 * (96 / 72),
      top: 80 * (96 / 72),
      width: 42 * (96 / 72),
      height: 24 * (96 / 72),
    });
  });
});
