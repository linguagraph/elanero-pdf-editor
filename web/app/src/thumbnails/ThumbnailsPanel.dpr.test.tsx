import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';
import { RenderScheduler } from '../view/renderScheduler';
import { thumbnailScaleMilli } from '../view/thumbnails';
import { ThumbnailsPanel } from './ThumbnailsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A one-page fake engine: each render.page answers at once with a blank page, and every request is
// recorded so the test can see the scale each thumbnail was asked for.
function fakeRpc() {
  const renders: number[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        return Promise.resolve({ pages: [{ width: 612, height: 792, rotation: 0 }] });
      }
      const request = params as Methods['render.page']['params'];
      renders.push(request.scale_milli);
      return Promise.resolve({
        width: 1,
        height: 1,
        revision: request.revision,
        format: 'rgba' as const,
        pixels: new ArrayBuffer(4),
      });
    }),
  };
  return { rpc: rpc as unknown as PageRpc, renders };
}

// jsdom has no matchMedia: the fake keeps each change listener so a test can fire a ratio change.
let listeners: (() => void)[] = [];

function setRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let host: HTMLDivElement;
let root: Root;
let originalRatio: number;

beforeEach(() => {
  originalRatio = window.devicePixelRatio;
  listeners = [];
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      listeners = listeners.filter((l) => l !== listener);
    },
  })) as unknown as typeof window.matchMedia;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  setRatio(originalRatio);
  vi.restoreAllMocks();
});

describe('ThumbnailsPanel on a devicePixelRatio change', () => {
  it('re-renders the visible thumbnails at the scale of the new ratio', async () => {
    setRatio(1);
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    act(() => {
      root.render(
        <ThumbnailsPanel
          rpc={rpc}
          handle="h"
          scheduler={scheduler}
          onSelect={() => undefined}
          onClose={() => undefined}
        />,
      );
    });
    await flush();
    await flush();
    const size = { width: 612, height: 792, rotation: 0 };
    expect(renders).toContain(thumbnailScaleMilli(size, 1));

    const current = [...listeners];
    setRatio(2);
    act(() => {
      for (const listener of current) listener();
    });
    await flush();
    await flush();
    expect(renders).toContain(thumbnailScaleMilli(size, 2));
  });
});
