import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import { computeColumn } from './layout';
import { CSS_PX_PER_POINT } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Session.pages answers at once; render.page never answers, which keeps the test to the scroll.
function fakeRpc(pageCount: number): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: pageCount }, () => ({
            width: 612,
            height: 792,
            rotation: 0,
          })),
          labels: [],
        });
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

const PAGES = Array.from({ length: 5 }, () => ({ width: 612, height: 792 }));

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  // The geometry below is at 100 %; the saved default is Fit width otherwise.
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

async function mountWithScroller(): Promise<{
  scroller: HTMLElement;
  handle: { current: DocumentViewHandle | null };
}> {
  const handle: { current: DocumentViewHandle | null } = { current: null };
  act(() => {
    root.render(
      <DocumentView
        rpc={fakeRpc(PAGES.length)}
        handle="h"
        ref={(value) => {
          handle.current = value;
        }}
      />,
    );
  });
  await flush();
  const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
  if (scroller === null) throw new Error('no scroll element');
  // jsdom has no layout; a plain property lets the test read what the view wrote.
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });
  return { scroller, handle };
}

describe('DocumentView.revealRect', () => {
  it('scrolls a rectangle that is below the viewport into view, with the page gap above it', async () => {
    const { scroller, handle } = await mountWithScroller();
    const layout = computeColumn(PAGES, 1);
    const box = layout.boxes[3];
    if (box === undefined) throw new Error('no box for page 4');
    const k = CSS_PX_PER_POINT;
    // Near the foot of page 4, so its top is far below the 768 px jsdom viewport.
    act(() => handle.current?.revealRect(3, { x0: 50, y0: 700, x1: 200, y1: 720 }));
    expect(scroller.scrollTop).toBeCloseTo(Math.max(0, box.top + 700 * k - 12 * k));
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it('leaves the scroll alone when the rectangle is already in view', async () => {
    const { scroller, handle } = await mountWithScroller();
    act(() => handle.current?.revealRect(0, { x0: 50, y0: 100, x1: 200, y1: 110 }));
    expect(scroller.scrollTop).toBe(0);
  });

  it('does nothing for a page that is not in the document', async () => {
    const { scroller, handle } = await mountWithScroller();
    Object.defineProperty(scroller, 'scrollTop', { value: 40, writable: true, configurable: true });
    act(() => handle.current?.revealRect(9, { x0: 0, y0: 0, x1: 1, y1: 1 }));
    expect(scroller.scrollTop).toBe(40);
  });
});
