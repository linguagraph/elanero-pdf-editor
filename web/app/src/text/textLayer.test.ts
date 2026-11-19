import { describe, expect, it } from 'vitest';
import { decodeTextLayer, placeLines } from './textLayer';

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
    expect(decodeTextLayer({ text: TEXT, char_boxes: BOXES, line_numbers: NUMBERS })).toEqual([
      { text: 'ab', x0: 10, y0: 20, x1: 30, y1: 30 },
      { text: 'cd', x0: 10, y0: 40, x1: 31, y1: 52 },
    ]);
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
    expect(lines).toEqual([{ text: '𝔸b', x0: 1, y0: 1, x1: 4, y1: 4 }]);
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
