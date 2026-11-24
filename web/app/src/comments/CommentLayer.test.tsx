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
      ...Array<string>(10).fill('false'),
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

  // Page points from the test's own rounding, so float noise in the pointer offsets does not show.
  const roundedPoints = (points: readonly { x: number; y: number }[] | undefined) =>
    points?.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));

  // Types into the open form's textarea and submits it.
  const typeAndSubmit = (text: string) => {
    const textarea = container.querySelector('textarea');
    const form = container.querySelector('form');
    if (textarea === null || form === null) throw new Error('no form');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setValue?.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  };

  it('a callout takes its tip on a click, then its box by a drag, then its text', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="callout" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50 * px, 50 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 50 * px));
    expect(container.querySelector('.comment-tip')).not.toBeNull();
    expect(onPlace).not.toHaveBeenCalled();

    act(() => pointer(el, 'pointerdown', 150 * px, 100 * px));
    act(() => pointer(el, 'pointermove', 250 * px, 140 * px));
    // The leader runs from the tip to the box's left side while the box is drawn.
    expect(container.querySelector('.comment-line-preview polyline')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 250 * px, 140 * px));
    expect(container.querySelector('.comment-tip')).toBeNull();
    expect(container.querySelector('form')).not.toBeNull();
    typeAndSubmit('Look');
    expect(onPlace).toHaveBeenCalledTimes(1);
    const [rect, text, points] = onPlace.mock.calls[0] ?? [];
    expect(rect).toEqual({
      x0: expect.closeTo(150, 6),
      y0: expect.closeTo(100, 6),
      x1: expect.closeTo(250, 6),
      y1: expect.closeTo(140, 6),
    });
    expect(text).toBe('Look');
    expect(roundedPoints(points)).toEqual([{ x: 50, y: 50 }]);
  });

  it('a callout whose box is a click gets the default box on the side away from its tip', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="callout" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50 * px, 50 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 50 * px));
    act(() => pointer(el, 'pointerdown', 200 * px, 200 * px));
    act(() => pointer(el, 'pointerup', 200 * px, 200 * px));
    typeAndSubmit('Here');
    expect(onPlace).toHaveBeenCalledWith(
      {
        x0: expect.closeTo(200, 6),
        y0: expect.closeTo(180, 6),
        x1: expect.closeTo(380, 6),
        y1: expect.closeTo(220, 6),
      },
      'Here',
      [expect.objectContaining({ x: expect.closeTo(50, 6) })],
    );
  });

  it('a pen draws a stroke while dragged and places its points; a click places nothing', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="pen" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(el, 'pointermove', 20 * px, 10 * px));
    act(() => pointer(el, 'pointermove', 30 * px, 20 * px));
    expect(container.querySelector('.comment-line-preview polyline')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 30 * px, 20 * px));
    expect(onPlace).toHaveBeenCalledTimes(1);
    const [rect, text, points] = onPlace.mock.calls[0] ?? [];
    expect(rect).toEqual({
      x0: expect.closeTo(10, 6),
      y0: expect.closeTo(10, 6),
      x1: expect.closeTo(30, 6),
      y1: expect.closeTo(20, 6),
    });
    expect(text).toBe('');
    expect(roundedPoints(points)).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 20 },
    ]);
    expect(container.querySelector('.comment-line-preview')).toBeNull();

    act(() => pointer(el, 'pointerdown', 200 * px, 200 * px));
    act(() => pointer(el, 'pointerup', 200 * px, 200 * px));
    expect(onPlace).toHaveBeenCalledTimes(1);
  });

  it('a polygon takes a click per vertex and finishes on a double-click', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polygon" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    for (const [x, y] of [
      [10, 10],
      [100, 10],
      [100, 100],
      [100, 100], // the second click of the double-click: a repeat, dropped by the engine's rule
    ] as const) {
      act(() => pointer(el, 'pointerdown', x * px, y * px));
      act(() => pointer(el, 'pointerup', x * px, y * px));
    }
    expect(container.querySelector('.comment-line-preview polyline')).not.toBeNull();
    act(() => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onPlace).toHaveBeenCalledTimes(1);
    const [rect, , points] = onPlace.mock.calls[0] ?? [];
    expect(rect).toEqual({
      x0: expect.closeTo(10, 6),
      y0: expect.closeTo(10, 6),
      x1: expect.closeTo(100, 6),
      y1: expect.closeTo(100, 6),
    });
    expect(roundedPoints(points)).toEqual([
      { x: 10, y: 10 },
      { x: 100, y: 10 },
      { x: 100, y: 100 },
    ]);
    expect(container.querySelector('.comment-line-preview')).toBeNull();
  });

  it('a polygon closes when its first corner is clicked again', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polygon" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    for (const [x, y] of [
      [10, 10],
      [100, 10],
      [100, 100],
      [11, 11], // within 4 points of the first corner
    ] as const) {
      act(() => pointer(el, 'pointerdown', x * px, y * px));
      act(() => pointer(el, 'pointerup', x * px, y * px));
    }
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(roundedPoints(onPlace.mock.calls[0]?.[2])).toHaveLength(3);
  });

  it('a polyline finishes on Enter, and a polygon with too few corners places nothing', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polyline" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerup', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerdown', 50 * px, 40 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 40 * px));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(roundedPoints(onPlace.mock.calls[0]?.[2])).toEqual([
      { x: 10, y: 10 },
      { x: 50, y: 40 },
    ]);
    expect(onPlace.mock.calls[0]?.[0]).toEqual({
      x0: expect.closeTo(10, 6),
      y0: expect.closeTo(10, 6),
      x1: expect.closeTo(50, 6),
      y1: expect.closeTo(40, 6),
    });

    act(() => root.unmount());
    root = createRoot(container);
    const polygon = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polygon" zoom={1} widthPt={612} heightPt={792} onPlace={polygon} />,
      ),
    );
    const again = layer();
    if (again === null) throw new Error('no layer');
    act(() => pointer(again, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(again, 'pointerup', 10 * px, 10 * px));
    act(() => pointer(again, 'pointerdown', 50 * px, 40 * px));
    act(() => pointer(again, 'pointerup', 50 * px, 40 * px));
    act(() => again.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(polygon).not.toHaveBeenCalled();
    expect(container.querySelector('.comment-line-preview')).toBeNull();
  });

  // A key press that the test can read back: defaultPrevented is set only if a handler took it.
  const pressKey = (key: string, target: EventTarget = window): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it('Escape cancels a polygon in progress: its preview is gone and a later finish places nothing', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polygon" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerup', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerdown', 50 * px, 40 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 40 * px));
    expect(container.querySelector('.comment-line-preview')).not.toBeNull();

    const escape = pressKey('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('.comment-line-preview')).toBeNull();

    act(() => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    pressKey('Enter');
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('Escape removes the tip of a callout in progress', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="callout" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 50 * px, 50 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 50 * px));
    expect(container.querySelector('.comment-tip')).not.toBeNull();

    const escape = pressKey('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('.comment-tip')).toBeNull();
    // The next click takes a new tip, as a callout starts again from nothing.
    act(() => pointer(el, 'pointerdown', 150 * px, 100 * px));
    act(() => pointer(el, 'pointerup', 150 * px, 100 * px));
    expect(container.querySelector('.comment-tip')).not.toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('Escape cancels a pen stroke mid-drag, so releasing the pointer places nothing', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="pen" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const el = layer();
    if (el === null) throw new Error('no layer');
    act(() => pointer(el, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(el, 'pointermove', 30 * px, 20 * px));
    expect(container.querySelector('.comment-line-preview polyline')).not.toBeNull();

    const escape = pressKey('Escape');
    expect(escape.defaultPrevented).toBe(true);
    expect(container.querySelector('.comment-line-preview')).toBeNull();
    act(() => pointer(el, 'pointerup', 30 * px, 20 * px));
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('Escape with no gesture in progress is not prevented', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <CommentLayer tool="polygon" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />,
      ),
    );
    const escape = pressKey('Escape');
    expect(escape.defaultPrevented).toBe(false);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('Enter from a focused input does not finish a polyline in progress', () => {
    const onPlace = vi.fn();
    act(() =>
      root.render(
        <>
          <input aria-label="field" />
          <CommentLayer tool="polyline" zoom={1} widthPt={612} heightPt={792} onPlace={onPlace} />
        </>,
      ),
    );
    const el = layer();
    const field = container.querySelector('input');
    if (el === null || field === null) throw new Error('no layer or field');
    act(() => pointer(el, 'pointerdown', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerup', 10 * px, 10 * px));
    act(() => pointer(el, 'pointerdown', 50 * px, 40 * px));
    act(() => pointer(el, 'pointerup', 50 * px, 40 * px));

    const enter = pressKey('Enter', field);
    expect(enter.defaultPrevented).toBe(false);
    expect(onPlace).not.toHaveBeenCalled();
    expect(container.querySelector('.comment-line-preview')).not.toBeNull();
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
