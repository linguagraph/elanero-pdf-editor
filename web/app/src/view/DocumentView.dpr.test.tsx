import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView } from './DocumentView';
import { scaleMilli } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A fake engine with one Letter page. Every render.page is recorded and rejected at once, so the
// scheduler's slots free up and the queue settles between the test's steps.
function fakeRpc() {
  const renders: { scale_milli: number }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        return Promise.resolve({ pages: [{ width: 612, height: 792, rotation: 0 }], labels: [] });
      }
      if (method === 'text.layer') return new Promise(() => undefined);
      if (method === 'render.page' || method === 'render.tile') {
        renders.push(params as { scale_milli: number });
        return Promise.reject(new Error('render stub'));
      }
      return new Promise(() => undefined);
    }),
  };
  return { rpc: rpc as unknown as PageRpc, renders };
}

// jsdom has no matchMedia: the fake keeps each change listener so a test can fire a ratio change.
let listeners: (() => void)[] = [];

function setRatio(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
}

// The browser reports a ratio change through the resolution query armed at the old ratio.
function changeRatio(value: number): void {
  setRatio(value);
  const current = [...listeners];
  act(() => {
    for (const listener of current) listener();
  });
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
  window.localStorage.clear();
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  originalRatio = window.devicePixelRatio;
  listeners = [];
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    removeEventListener: (_type: string, listener: () => void) => {
      listeners = listeners.filter((l) => l !== listener);
    },
  })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setRatio(originalRatio);
});

describe('DocumentView on a devicePixelRatio change', () => {
  it('re-renders the visible page at the scale of the new ratio', async () => {
    setRatio(1);
    const { rpc, renders } = fakeRpc();
    act(() => root.render(<DocumentView rpc={rpc} handle="doc-1" />));
    await flush();
    expect(renders.some((r) => r.scale_milli === scaleMilli(1, 1))).toBe(true);

    changeRatio(2);
    await flush();
    await flush();
    expect(renders.some((r) => r.scale_milli === scaleMilli(1, 2))).toBe(true);
  });

  it('does not re-render when a resize leaves the ratio unchanged', async () => {
    setRatio(1);
    const { rpc, renders } = fakeRpc();
    act(() => root.render(<DocumentView rpc={rpc} handle="doc-1" />));
    await flush();
    await flush();
    const before = renders.length;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    await flush();
    await flush();
    expect(renders.length).toBe(before);
    expect(renders.every((r) => r.scale_milli === scaleMilli(1, 1))).toBe(true);
  });
});
