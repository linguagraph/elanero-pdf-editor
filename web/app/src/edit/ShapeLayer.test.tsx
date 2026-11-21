import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { t } from '../i18n/t';
import { ShapeLayer, type ShapeLayerProps } from './ShapeLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out, so the page's top-left corner is the viewport origin.
function pointer(target: Element, type: string, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
}

function key(target: Element, name: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: name }));
}

const px = CSS_PX_PER_POINT; // one point in CSS pixels at zoom 1

describe('the shape layer on a page', () => {
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
    const el = container.querySelector<HTMLDivElement>('.shape-layer');
    if (el === null) throw new Error('no layer');
    // jsdom has no pointer capture; the layer only needs the call to exist.
    el.setPointerCapture = () => undefined;
    return el;
  };

  function render(overrides: Partial<ShapeLayerProps> = {}) {
    const props: ShapeLayerProps = {
      kind: 'rectangle',
      zoom: 1,
      widthPt: 612,
      heightPt: 792,
      focusable: true,
      onDraw: vi.fn(),
      onStop: vi.fn(),
      ...overrides,
    };
    act(() => root.render(<ShapeLayer {...props} />));
    return props;
  }

  it('a drag shows a box preview and draws the box between its ends', () => {
    const { onDraw } = render();
    const el = layer();
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 100 * px, 90 * px));
    expect(container.querySelector('.shape-preview')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 144 * px, 144 * px));
    expect(onDraw).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rectangle', rect: { x0: 72, y0: 72, x1: 144, y1: 144 } }),
    );
    expect(container.querySelector('.shape-preview')).toBeNull();
  });

  it('an ellipse preview is drawn as an ellipse', () => {
    render({ kind: 'ellipse' });
    const el = layer();
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 144 * px, 144 * px));
    expect(container.querySelector('.shape-preview--ellipse')).not.toBeNull();
  });

  it('a line shows a segment preview and is drawn between its ends', () => {
    const { onDraw } = render({ kind: 'line' });
    const el = layer();
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => pointer(el, 'pointermove', 200 * px, 100 * px));
    expect(container.querySelector('.shape-line-preview line')).not.toBeNull();
    act(() => pointer(el, 'pointerup', 200 * px, 100 * px));
    // Pixel-to-point conversion is not exact in floating point, so the ends are compared closely.
    const spec = vi.mocked(onDraw).mock.calls[0]?.[0];
    expect(spec?.kind).toBe('line');
    expect(spec?.start?.x).toBeCloseTo(72);
    expect(spec?.start?.y).toBeCloseTo(72);
    expect(spec?.end?.x).toBeCloseTo(200);
    expect(spec?.end?.y).toBeCloseTo(100);
  });

  it('a drag that draws nothing reports null, so the caller can say so', () => {
    const { onDraw } = render();
    const el = layer();
    // The bottom-right corner of the page: a click there leaves an empty box.
    act(() => pointer(el, 'pointerdown', 612 * px, 792 * px));
    act(() => pointer(el, 'pointerup', 612 * px, 792 * px));
    expect(onDraw).toHaveBeenCalledWith(null);
  });

  it('Escape during a drag cancels it, and draws nothing', () => {
    const { onDraw, onStop } = render();
    const el = layer();
    act(() => pointer(el, 'pointerdown', 72 * px, 72 * px));
    act(() => key(el, 'Escape'));
    expect(container.querySelector('.shape-preview')).toBeNull();
    expect(onStop).not.toHaveBeenCalled();
    act(() => pointer(el, 'pointerup', 144 * px, 144 * px));
    expect(onDraw).not.toHaveBeenCalled();
  });

  it('Escape with nothing being dragged stops the tool', () => {
    const { onStop } = render();
    act(() => key(layer(), 'Escape'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('Enter places the default-size shape in the middle of the page', () => {
    const { onDraw } = render({ widthPt: 600, heightPt: 800 });
    act(() => key(layer(), 'Enter'));
    expect(onDraw).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rectangle', rect: { x0: 240, y0: 360, x1: 360, y1: 440 } }),
    );
  });

  it('only the focusable (current) page takes the keyboard', () => {
    render({ focusable: false });
    expect(layer().tabIndex).toBe(-1);
    render({ focusable: true });
    expect(layer().tabIndex).toBe(0);
  });

  it('is labelled as an application with the instructions', () => {
    render();
    expect(layer().getAttribute('aria-label')).toBe(t('edit.shape.layer'));
    expect(layer().getAttribute('role')).toBe('application');
  });
});
