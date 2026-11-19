// The text layer of one page (W5.4, W1.4 section 10): the page's text lines with their boxes, decoded
// from text.layer and placed in CSS pixels for a zoom. The browser selects and copies the spans this
// makes natively; the boxes only place them over the page image.
import type { TextLayerResult } from '../rpc/generated';
import { CSS_PX_PER_POINT } from '../view/zoom';

// The line separator the engine puts between lines (services/text.py LINE_SEP).
const LINE_SEP = '\n';

// One line of the page. The box is the union of the line's char boxes, in points, visible page
// space, origin top-left.
export interface TextLine {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// Where a line goes in the page element, in CSS pixels from its top-left corner.
export interface PlacedLine {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface LineInProgress {
  number: number;
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  boxed: boolean;
}

// Splits the layer into lines. Chars are counted as code points, the same as the engine's
// indexes; a line ends at a separator or where the line number changes. A char without a box
// (zeros) keeps its text but does not stretch the line's box.
export function decodeTextLayer(
  layer: Pick<TextLayerResult, 'text' | 'char_boxes' | 'line_numbers'>,
): TextLine[] {
  const chars = Array.from(layer.text);
  const boxes = new Float32Array(layer.char_boxes);
  const numbers = new Uint32Array(layer.line_numbers);
  const count = Math.min(chars.length, Math.floor(boxes.length / 4), numbers.length);
  const finished: LineInProgress[] = [];
  let current: LineInProgress | null = null;
  for (let index = 0; index < count; index += 1) {
    const ch = chars[index] ?? '';
    if (ch === LINE_SEP) {
      current = null;
      continue;
    }
    const number = numbers[index] ?? 0;
    if (current === null || current.number !== number) {
      current = { number, text: '', x0: 0, y0: 0, x1: 0, y1: 0, boxed: false };
      finished.push(current);
    }
    current.text += ch;
    const x0 = boxes[index * 4] ?? 0;
    const y0 = boxes[index * 4 + 1] ?? 0;
    const x1 = boxes[index * 4 + 2] ?? 0;
    const y1 = boxes[index * 4 + 3] ?? 0;
    if (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0) continue;
    if (!current.boxed) {
      current.x0 = x0;
      current.y0 = y0;
      current.x1 = x1;
      current.y1 = y1;
      current.boxed = true;
    } else {
      current.x0 = Math.min(current.x0, x0);
      current.y0 = Math.min(current.y0, y0);
      current.x1 = Math.max(current.x1, x1);
      current.y1 = Math.max(current.y1, y1);
    }
  }
  return finished
    .filter((line) => line.boxed && line.text.trim() !== '')
    .map(({ text, x0, y0, x1, y1 }) => ({ text, x0, y0, x1, y1 }));
}

// The lines at a zoom: points times zoom times 96/72, as the page box is laid out (layout.ts).
export function placeLines(lines: readonly TextLine[], zoom: number): PlacedLine[] {
  const k = zoom * CSS_PX_PER_POINT;
  return lines.map((line) => ({
    text: line.text,
    left: line.x0 * k,
    top: line.y0 * k,
    width: (line.x1 - line.x0) * k,
    height: (line.y1 - line.y0) * k,
  }));
}
