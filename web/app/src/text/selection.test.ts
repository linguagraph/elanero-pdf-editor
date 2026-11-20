import { afterEach, describe, expect, it } from 'vitest';
import { domSelectionAreas, type TextLineLookup } from './selection';
import { decodeTextLayer, type TextLine } from './textLayer';

// Page 0: "ab" and "cd" (the same layer as textLayer.test.ts). Page 1: "ef", one line.
const LAYER_0 = {
  text: 'ab\ncd',
  char_boxes: new Float32Array([
    10, 20, 20, 30, 20, 20, 30, 30, 0, 0, 0, 0, 10, 40, 20, 52, 20, 40, 31, 52,
  ]).buffer,
  line_numbers: new Uint32Array([0, 0, 0, 1, 1]).buffer,
};
const LAYER_1 = {
  text: 'ef',
  char_boxes: new Float32Array([100, 100, 110, 110, 110, 100, 120, 110]).buffer,
  line_numbers: new Uint32Array([0, 0]).buffer,
};

const LINES_0 = decodeTextLayer(LAYER_0);
const LINES_1 = decodeTextLayer(LAYER_1);

// The page elements as PageTextLayer and DocumentView render them: one span per line.
function mountPage(index: number, lines: readonly TextLine[]): HTMLElement {
  const page = document.createElement('div');
  page.className = 'doc-page';
  page.dataset.page = String(index);
  lines.forEach((line, lineIndex) => {
    const span = document.createElement('div');
    span.className = 'page-text-line';
    span.dataset.line = String(lineIndex);
    span.textContent = line.text;
    page.append(span);
  });
  document.body.append(page);
  return page;
}

function textOf(page: HTMLElement, lineIndex: number): Text {
  const text = page.querySelectorAll('.page-text-line')[lineIndex]?.firstChild;
  if (!(text instanceof Text)) throw new Error('no text node');
  return text;
}

function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): Selection | null {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return selection;
}

const lookup: TextLineLookup = (page) => (page === 0 ? LINES_0 : page === 1 ? LINES_1 : undefined);

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('domSelectionAreas', () => {
  it('maps a partly selected line to the chars the selection covers', () => {
    const page = mountPage(0, LINES_0);
    // From "a|b" in line one to "c|d" in line two: "b", the separator, and "c".
    const selection = select(textOf(page, 0), 1, textOf(page, 1), 1);
    const areas = domSelectionAreas(selection, lookup);
    expect(areas).toHaveLength(1);
    expect(areas[0]).toMatchObject({
      page: 0,
      rect: { x0: 10, y0: 20, x1: 30, y1: 52 },
      text: 'b\nc',
    });
    expect(areas[0]?.quads).toHaveLength(2);
  });

  it('covers a whole page when the selection spans its spans', () => {
    const page = mountPage(0, LINES_0);
    const selection = select(page, 0, page, page.childNodes.length);
    const [area] = domSelectionAreas(selection, lookup);
    expect(area?.rect).toEqual({ x0: 10, y0: 20, x1: 31, y1: 52 });
    expect(area?.text).toBe('ab\ncd');
  });

  it('gives one area per page, in page order', () => {
    const first = mountPage(0, LINES_0);
    const second = mountPage(1, LINES_1);
    const selection = select(textOf(first, 0), 0, textOf(second, 0), 2);
    const areas = domSelectionAreas(selection, lookup);
    expect(areas.map((area) => area.page)).toEqual([0, 1]);
    expect(areas[1]).toMatchObject({ rect: { x0: 100, y0: 100, x1: 120, y1: 110 }, text: 'ef' });
  });

  it('maps UTF-16 offsets past a surrogate pair to code points', () => {
    const layer = {
      text: '𝔸b',
      char_boxes: new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]).buffer,
      line_numbers: new Uint32Array([0, 0]).buffer,
    };
    const lines = decodeTextLayer(layer);
    const page = mountPage(0, lines);
    // "𝔸" is two UTF-16 units, so offset 2 is the start of "b".
    const selection = select(textOf(page, 0), 2, textOf(page, 0), 3);
    const [area] = domSelectionAreas(selection, () => lines);
    expect(area).toMatchObject({ rect: { x0: 3, y0: 3, x1: 4, y1: 4 }, text: 'b' });
  });

  it('gives nothing for a selection outside the text layer', () => {
    mountPage(0, LINES_0);
    const outside = document.createElement('p');
    outside.textContent = 'toolbar';
    document.body.append(outside);
    expect(domSelectionAreas(select(outside, 0, outside, 1), lookup)).toEqual([]);
  });

  it('gives nothing without a selection', () => {
    expect(domSelectionAreas(null, lookup)).toEqual([]);
    window.getSelection()?.removeAllRanges();
    expect(domSelectionAreas(window.getSelection(), lookup)).toEqual([]);
  });

  it('skips a page whose lines have not arrived', () => {
    const first = mountPage(0, LINES_0);
    const second = mountPage(1, LINES_1);
    const selection = select(textOf(first, 0), 0, textOf(second, 0), 2);
    const areas = domSelectionAreas(selection, (page) => (page === 0 ? LINES_0 : undefined));
    expect(areas.map((area) => area.page)).toEqual([0]);
  });

  it('skips a span whose text is not the line the cache holds', () => {
    const page = mountPage(0, LINES_0);
    const selection = select(textOf(page, 0), 0, textOf(page, 0), 2);
    const [first] = LINES_0;
    const stale: TextLine[] = first === undefined ? [] : [{ ...first, text: 'xy' }];
    expect(domSelectionAreas(selection, (p) => (p === 0 ? stale : undefined))).toEqual([]);
  });
});
