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
  // The code-point index of the line's first char in the layer's text (the engine's indexes), so a
  // selection's offsets and the lines' chars share one numbering.
  readonly start: number;
  // Float32 x 4 per char (x0, y0, x1, y1): a view on the layer's boxes, zeros for a char without one.
  readonly chars: Float32Array;
}

// A box in page points, visible page space, origin top-left.
export interface AreaRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface AreaPoint {
  readonly x: number;
  readonly y: number;
}

// The four corners of one line's box, as the redaction marks take them (quadPoints order).
export interface AreaQuad {
  readonly ul: AreaPoint;
  readonly ur: AreaPoint;
  readonly ll: AreaPoint;
  readonly lr: AreaPoint;
}

// The part of a page a selection covers: the union rect, one quad per line, and the selected text.
export interface PageArea {
  readonly page: number;
  readonly rect: AreaRect;
  readonly quads: readonly AreaQuad[];
  readonly text: string;
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
  start: number;
  first: number;
  last: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  boxed: boolean;
}

// The layer as the decoders read it: the reply's one char buffer split into its two parts.
export type SplitTextLayer = Omit<TextLayerResult, 'chars'> & {
  char_boxes: ArrayBuffer;
  line_numbers: ArrayBuffer;
};

// The engine sends the char data as one buffer, because a reply carries at most one: Float32 x 4
// per char (the boxes) for all chars, then Uint32 per char (the line numbers), so 20 bytes a char.
export function splitCharData(
  chars: ArrayBuffer,
): Pick<SplitTextLayer, 'char_boxes' | 'line_numbers'> {
  const count = Math.floor(chars.byteLength / 20);
  return {
    char_boxes: chars.slice(0, count * 16),
    line_numbers: chars.slice(count * 16, count * 20),
  };
}

// Splits the layer into lines. Chars are counted as code points, the same as the engine's
// indexes; a line ends at a separator or where the line number changes. A char without a box
// (zeros) keeps its text but does not stretch the line's box.
export function decodeTextLayer(
  layer: Pick<SplitTextLayer, 'text' | 'char_boxes' | 'line_numbers'>,
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
      current = {
        number,
        text: '',
        start: index,
        first: index,
        last: index,
        x0: 0,
        y0: 0,
        x1: 0,
        y1: 0,
        boxed: false,
      };
      finished.push(current);
    }
    current.text += ch;
    current.last = index;
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
    .map((line) => ({
      text: line.text,
      x0: line.x0,
      y0: line.y0,
      x1: line.x1,
      y1: line.y1,
      start: line.start,
      // A line's chars are contiguous in the layer, so its boxes are one subarray (no copy).
      chars: boxes.subarray(line.first * 4, (line.last + 1) * 4),
    }));
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

// The area a selection covers on one page: the code points [startCp, endCp) of the layer's text,
// clipped to each line. A line's part is the union of its selected char boxes (zeros skipped); the
// page's rect is the union of the line parts, with one quad per line. Null when nothing selected
// has a box. The boxes are visible page space already, so nothing is converted here.
export function selectionAreas(
  lines: readonly TextLine[],
  page: number,
  startCp: number,
  endCp: number,
): PageArea | null {
  const quads: AreaQuad[] = [];
  const texts: string[] = [];
  let rect: AreaRect | null = null;
  for (const line of lines) {
    const count = line.chars.length / 4;
    const from = Math.max(startCp, line.start);
    const to = Math.min(endCp, line.start + count);
    if (from >= to) continue;
    let box: AreaRect | null = null;
    for (let cp = from; cp < to; cp += 1) {
      const i = (cp - line.start) * 4;
      const x0 = line.chars[i] ?? 0;
      const y0 = line.chars[i + 1] ?? 0;
      const x1 = line.chars[i + 2] ?? 0;
      const y1 = line.chars[i + 3] ?? 0;
      if (x0 === 0 && y0 === 0 && x1 === 0 && y1 === 0) continue;
      box = box === null ? { x0, y0, x1, y1 } : unionRect(box, { x0, y0, x1, y1 });
    }
    if (box === null) continue;
    quads.push({
      ul: { x: box.x0, y: box.y0 },
      ur: { x: box.x1, y: box.y0 },
      ll: { x: box.x0, y: box.y1 },
      lr: { x: box.x1, y: box.y1 },
    });
    rect = rect === null ? box : unionRect(rect, box);
    texts.push(
      Array.from(line.text)
        .slice(from - line.start, to - line.start)
        .join(''),
    );
  }
  if (rect === null) return null;
  return { page, rect, quads, text: texts.join('\n') };
}

function unionRect(a: AreaRect, b: AreaRect): AreaRect {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}
