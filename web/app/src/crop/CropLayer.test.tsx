import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CropLayer } from './CropLayer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(onDraw: (rect: unknown) => void, zoom = 1): HTMLElement {
  act(() => {
    root.render(<CropLayer zoom={zoom} widthPt={612} heightPt={792} onDraw={onDraw} />);
  });
  const layer = host.querySelector<HTMLElement>('.crop-layer');
  if (layer === null) throw new Error('no crop layer');
  // jsdom has no layout: the layer covers the page box at the origin.
  layer.getBoundingClientRect = () => new DOMRect(0, 0, 816, 1056);
  return layer;
}

function pointer(element: HTMLElement, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe('CropLayer', () => {
  it('reports the dragged box as a page rectangle in points', () => {
    const onDraw = vi.fn();
    const layer = mount(onDraw);
    pointer(layer, 'pointerdown', 96, 144);
    pointer(layer, 'pointermove', 200, 200);
    expect(host.querySelector('.crop-preview')).not.toBeNull();
    pointer(layer, 'pointerup', 288, 288);
    expect(onDraw).toHaveBeenCalledWith({ x0: 72, y0: 108, x1: 216, y1: 216 });
    expect(host.querySelector('.crop-preview')).toBeNull();
  });

  it('draws nothing for a click', () => {
    const onDraw = vi.fn();
    const layer = mount(onDraw);
    pointer(layer, 'pointerdown', 96, 144);
    pointer(layer, 'pointerup', 96, 144);
    expect(onDraw).not.toHaveBeenCalled();
  });

  it('ignores a press with a button other than the primary one', () => {
    const onDraw = vi.fn();
    const layer = mount(onDraw);
    const event = new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 96 });
    act(() => {
      layer.dispatchEvent(event);
    });
    expect(host.querySelector('.crop-preview')).toBeNull();
  });
});
