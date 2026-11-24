import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { CommentLayer, type CommentLayerProps } from './CommentLayer';
import { CommentToolbar } from './CommentToolbar';
import type { CommentToolId } from './tools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// DocumentView keys the layer on the tool, so a tool change remounts it and drops any open form
// or gesture in progress. This wrapper does the same, so the tests below cover that behavior.
function KeyedLayer({
  tool,
  onPlace,
}: {
  tool: CommentToolId;
  onPlace: CommentLayerProps['onPlace'];
}) {
  return (
    <CommentLayer key={tool} tool={tool} zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />
  );
}

// jsdom lays nothing out, so the page's top-left corner is the viewport origin.
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

describe('comment tools on a page', () => {
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

  const layer = () => container.querySelector<HTMLDivElement>('.comment-layer');
  const px = CSS_PX_PER_POINT; // one point in CSS pixels at zoom 1

  it('a drag draws the box between its ends, in page points', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="rectangle" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 100 * px, 90 * px));
    expect(container.querySelector('.comment-preview')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 144 * px, 144 * px));
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 144, y1: 144 }, '', []);
    expect(container.querySelector('.comment-preview')).toBeNull();
  });

  it('a click without a drag places nothing for a highlight', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="highlight" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50, 50));
    act(() => pointer(el, 'pointerup', 50, 50));
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('a click places a sticky note after its text is entered', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="note" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 96, 96));
    const textarea = container.querySelector('textarea');
    const form = container.querySelector('form');
    if (textarea === null || form === null) throw new Error('no note form');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(textarea, 'Check this');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 72, y1: 72 }, 'Check this', []);
    expect(container.querySelector('form')).toBeNull();
  });

  it('the toolbar turns a tool off when it is pressed again, and reports the choice', () => {
    const onChoose = vi.fn();
    act(() => root.render(<CommentToolbar tool="note" onChoose={onChoose} />));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
      'false',
    ]);
    act(() => buttons[0]?.click());
    expect(onChoose).toHaveBeenLastCalledWith(null);
    act(() => buttons[1]?.click());
    expect(onChoose).toHaveBeenLastCalledWith('rectangle');
  });

  it('a drag of an oval draws the box, shaped as an oval', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="oval" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 100 * px, 90 * px));
    expect(container.querySelector('.comment-preview-oval')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 144 * px, 120 * px));
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 144, y1: 120 }, '', []);
  });

  it('a drag of a line places its two ends, and a click places nothing', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="line" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50 * px, 50 * px));
    act(() => pointer(el, 'pointermove', 120 * px, 80 * px));
    expect(container.querySelector('.comment-line-preview line')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 120 * px, 80 * px));
    // Pointer offsets round through CSS pixels, so the page points carry float noise.
    expect(onPlace).toHaveBeenCalledWith(
      { x0: expect.closeTo(50, 6), y0: expect.closeTo(50, 6), x1: 120, y1: 80 },
      '',
      [
        { x: expect.closeTo(50, 6), y: expect.closeTo(50, 6) },
        { x: 120, y: 80 },
      ],
    );
    expect(container.querySelector('.comment-line-preview')).toBeNull();

    act(() => pointer(el, 'pointerdown', 200 * px, 200 * px));
    act(() => pointer(el, 'pointerup', 200 * px, 200 * px));
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it('a click on a text box opens its text form at the click, then places it at the default size', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="textbox" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 96, 96));
    act(() => pointer(el, 'pointerup', 96, 96));
    const textarea = container.querySelector('textarea');
    const form = container.querySelector('form');
    if (textarea === null || form === null) throw new Error('no text box form');
    expect(form.style.left).toBe('96px');
    const add = form.querySelector('button[type="submit"]');
    expect(add?.hasAttribute('disabled')).toBe(true);
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(textarea, 'Boxed');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 72, y1: 72 }, 'Boxed', []);
    expect(container.querySelector('form')).toBeNull();
  });

  it('a drag on a text box places its drawn box with the text typed after it', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="textbox" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointerup', 200 * px, 110 * px));
    expect(onPlace).not.toHaveBeenCalled();
    expect(container.querySelector('.comment-preview')).not.toBeNull();
    const textarea = container.querySelector('textarea');
    const form = container.querySelector('form');
    if (textarea === null || form === null) throw new Error('no text box form');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(textarea, 'Dragged');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onPlace).toHaveBeenCalledWith(
      { x0: expect.closeTo(72, 6), y0: expect.closeTo(72, 6), x1: expect.closeTo(200, 6), y1: 110 },
      'Dragged',
      [],
    );
  });

  it('changing the tool clears an open text form, so it cannot submit as the new tool', () => {
    const onPlace = vi.fn();
    act(() => root.render(<KeyedLayer tool="textbox" onPlace={onPlace} />));
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 96, 96));
    act(() => pointer(el, 'pointerup', 96, 96));
    expect(container.querySelector('form')).not.toBeNull();

    act(() => root.render(<KeyedLayer tool="rectangle" onPlace={onPlace} />));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('.comment-preview')).toBeNull();
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('changing the tool cancels a box drag in progress', () => {
    const onPlace = vi.fn();
    act(() => root.render(<KeyedLayer tool="rectangle" onPlace={onPlace} />));
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 100 * px, 90 * px));
    expect(container.querySelector('.comment-preview')).not.toBeNull();

    act(() => root.render(<KeyedLayer tool="oval" onPlace={onPlace} />));
    expect(container.querySelector('.comment-preview')).toBeNull();
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('changing the tool cancels a line drag in progress', () => {
    const onPlace = vi.fn();
    act(() => root.render(<KeyedLayer tool="line" onPlace={onPlace} />));
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50 * px, 50 * px));
    act(() => pointer(el, 'pointermove', 120 * px, 80 * px));
    expect(container.querySelector('.comment-line-preview')).not.toBeNull();

    act(() => root.render(<KeyedLayer tool="arrow" onPlace={onPlace} />));
    expect(container.querySelector('.comment-line-preview')).toBeNull();
    expect(onPlace).not.toHaveBeenCalled();
  });
});
