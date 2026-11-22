import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { PageObjectDto, RectDto } from '../rpc/generated';
import { CSS_PX_PER_POINT } from '../view/zoom';
import type { TextEdit } from './EditLayer';
import { newTextBlock } from './commit';
import type { ObjectCache } from './objectCache';
import { TextBoxLayer, type TextBoxLayerProps } from './TextBoxLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out, so the page's top-left corner is the viewport origin.
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

function key(target: Element, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: name }));
}

const px = CSS_PX_PER_POINT; // one point in CSS pixels at zoom 1

const box = (x0: number, y0: number, x1: number, y1: number): RectDto => ({ x0, y0, x1, y1 });

const paragraph: PageObjectDto = {
  type: 'text',
  key: 'text:1',
  bbox: box(72, 72, 300, 120),
  text: 'Existing words',
  style: {
    font: 'Helvetica',
    size: 12,
    color: { r: 0, g: 0, b: 0, a: 1 },
    bold: false,
    italic: false,
    align: 'left',
    line_height: 1.2,
    char_spacing: 0,
    word_spacing: 0,
  },
  editable: true,
  reason: '',
  image_size: [0, 0],
  stroke: false,
  fill: false,
};

describe('the Add Text layer on a page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const layer = () => {
    const el = container.querySelector<HTMLDivElement>('.text-box-layer');
    if (el === null) throw new Error('no layer');
    // jsdom has no pointer capture; the layer only needs the call to exist.
    el.setPointerCapture = () => undefined;
    return el;
  };

  // The cache answers with the page's list: the existing paragraph unless a test says otherwise.
  function cacheWith(objects: readonly PageObjectDto[] = [paragraph]): ObjectCache {
    return {
      get: vi.fn(async () => ({ revision: 3, objects, truncated: false })),
    } as unknown as ObjectCache;
  }

  const rpc = { call: vi.fn(async () => ({ found: false })) } as unknown as PageRpc;

  function render(overrides: Partial<TextBoxLayerProps> = {}) {
    const props: TextBoxLayerProps = {
      cache: cacheWith(),
      page: 0,
      revision: 3,
      zoom: 1,
      widthPt: 612,
      heightPt: 792,
      focusable: true,
      rpc,
      handle: 'h1',
      editing: null,
      onDraw: vi.fn(),
      onOpenText: vi.fn(),
      onApply: vi.fn(async () => true),
      onClose: vi.fn(),
      commitOnLeave: () => true,
      onDrop: vi.fn(),
      onStop: vi.fn(),
      ...overrides,
    };
    act(() => root.render(<TextBoxLayer {...props} />));
    return props;
  }

  // A click is judged after the page's list is read, so the test waits for that read. The press
  // and the release are separate renders, as in a browser, so the release sees the press.
  async function click(el: Element, x: number, y: number): Promise<void> {
    act(() => pointer(el, 'pointerdown', x * px, y * px));
    await act(async () => pointer(el, 'pointerup', x * px, y * px));
  }

  it('a click places the default 200 by 40 pt box from the press point', async () => {
    const { onDraw } = render({ cache: cacheWith([]) });
    await click(layer(), 72, 72);
    expect(onDraw).toHaveBeenCalledWith(box(72, 72, 272, 112));
  });

  it('a click near the far corner moves the default box in, so it stays on the page', async () => {
    const { onDraw } = render({ cache: cacheWith([]) });
    await click(layer(), 612, 792);
    expect(onDraw).toHaveBeenCalledWith(box(412, 752, 612, 792));
  });

  it('a drag draws the box between its ends, with no list read', () => {
    const { onDraw, onOpenText } = render();
    const el = layer();
    act(() => {
      pointer(el, 'pointerdown', 72 * px, 72 * px);
      pointer(el, 'pointermove', 100 * px, 90 * px);
    });
    expect(container.querySelector('.shape-preview')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 144 * px, 144 * px));
    expect(onDraw).toHaveBeenCalledWith(box(72, 72, 144, 144));
    expect(onOpenText).not.toHaveBeenCalled();
  });

  it('a click on an editable text block opens that block instead of placing a box', async () => {
    const { onDraw, onOpenText } = render();
    await click(layer(), 100, 90);
    expect(onOpenText).toHaveBeenCalledWith(paragraph);
    expect(onDraw).not.toHaveBeenCalled();
  });

  it('a click on a block that cannot be edited places a box', async () => {
    const locked = { ...paragraph, editable: false, reason: 'rotated' };
    const { onDraw, onOpenText } = render({ cache: cacheWith([locked]) });
    await click(layer(), 100, 90);
    expect(onOpenText).not.toHaveBeenCalled();
    // The press is at (100, 90) pt; the pixel-to-point mapping is not exact in floating point.
    const drawn = vi.mocked(onDraw).mock.calls[0]?.[0];
    expect(drawn?.x0).toBeCloseTo(100);
    expect(drawn?.y0).toBeCloseTo(90);
    expect((drawn?.x1 ?? 0) - (drawn?.x0 ?? 0)).toBeCloseTo(200);
    expect((drawn?.y1 ?? 0) - (drawn?.y0 ?? 0)).toBeCloseTo(40);
  });

  it('Enter places the default box in the middle of the page', () => {
    const { onDraw } = render();
    act(() => key(layer(), 'Enter'));
    expect(onDraw).toHaveBeenCalledWith(box(206, 376, 406, 416));
  });

  it('Escape with nothing being drawn stops the tool', () => {
    const { onStop } = render();
    act(() => key(layer(), 'Escape'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('shows the paragraph editor for a new block, labelled as one, and ignores a press on the page', () => {
    const rect = box(72, 300, 272, 340);
    const editing: TextEdit = { page: 0, revision: 3, object: newTextBlock(rect), newRect: rect };
    const { onDraw } = render({ editing });
    const area = container.querySelector<HTMLTextAreaElement>('textarea.edit-editor');
    expect(area).not.toBeNull();
    expect(area?.getAttribute('aria-label')).toBe('New text');
    act(() => pointer(layer(), 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(layer(), 'pointerup', 10 * px, 10 * px));
    expect(onDraw).not.toHaveBeenCalled();
  });

  it('does not show the editor for an existing block (that one belongs to the Edit tool)', () => {
    const editing: TextEdit = { page: 0, revision: 3, object: paragraph };
    render({ editing });
    expect(container.querySelector('textarea.edit-editor')).toBeNull();
  });
});
