import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { CommentLayer } from './CommentLayer';
import { CommentToolbar } from './CommentToolbar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 144, y1: 144 }, '');
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
    expect(onPlace).toHaveBeenCalledWith({ x0: 72, y0: 72, x1: 72, y1: 72 }, 'Check this');
    expect(container.querySelector('form')).toBeNull();
  });

  it('the toolbar turns a tool off when it is pressed again, and reports the choice', () => {
    const onChoose = vi.fn();
    act(() => root.render(<CommentToolbar tool="note" onChoose={onChoose} />));
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    act(() => buttons[0]?.click());
    expect(onChoose).toHaveBeenLastCalledWith(null);
    act(() => buttons[1]?.click());
    expect(onChoose).toHaveBeenLastCalledWith('rectangle');
  });
});
