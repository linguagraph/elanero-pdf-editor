import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { scrollTopForPage, computeColumn } from './layout';

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
        });
      }
      return new Promise(() => {});
    }),
  };
  return rpc as unknown as PageRpc;
}

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

describe('DocumentView.scrollToPage', () => {
  it('scrolls the page list so the chosen page is at the top', async () => {
    const handle: { current: DocumentViewHandle | null } = { current: null };
    act(() => {
      root.render(
        <DocumentView
          rpc={fakeRpc(5)}
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

    const layout = computeColumn(
      Array.from({ length: 5 }, () => ({ width: 612, height: 792 })),
      1,
    );
    act(() => handle.current?.scrollToPage(3));
    expect(scroller.scrollTop).toBeCloseTo(scrollTopForPage(layout.boxes, 3, 1) ?? -1);
    expect(scroller.scrollTop).toBeGreaterThan(0);
  });

  it('does nothing for a page that is not in the document', async () => {
    const handle: { current: DocumentViewHandle | null } = { current: null };
    act(() => {
      root.render(
        <DocumentView
          rpc={fakeRpc(2)}
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
    Object.defineProperty(scroller, 'scrollTop', { value: 40, writable: true, configurable: true });
    act(() => handle.current?.scrollToPage(9));
    expect(scroller.scrollTop).toBe(40);
  });
});
