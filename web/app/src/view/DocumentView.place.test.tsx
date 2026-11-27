import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import type { DocumentViewHandle } from './DocumentView';
import {
  computeColumn,
  computeSpreads,
  fitWidthZoom,
  scrollTopForAnchor,
  viewAnchor,
  type PageBox,
} from './layout';
import { ViewWithStatus } from './viewWithStatus.testutil';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Letter pages. Only session.pages is answered; the renders and the text layers are never answered,
// so the view's queue does not change what the tests read.
const LETTER = { width: 612, height: 792 };

function fakeRpc(pageCount: number): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        const pages = Array.from({ length: pageCount }, () => ({ ...LETTER, rotation: 0 }));
        return Promise.resolve({ pages, labels: [] });
      }
      return new Promise(() => undefined);
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

const sizes = (count: number) => Array.from({ length: count }, () => LETTER);

// The scroll element of the view. jsdom has no layout, so scrollTop is a plain property the test
// sets; the view reads and writes it through the same property.
function scroller(): HTMLElement {
  const element = host.querySelector<HTMLElement>('.doc-view-scroll');
  if (element === null) throw new Error('no scroll element');
  return element;
}

function scrollTo(top: number): void {
  scroller().scrollTop = top;
  act(() => {
    scroller().dispatchEvent(new Event('scroll'));
  });
}

// A point 300 CSS px below the top of a page (a fraction of the page, not its top edge).
function pointOn(boxes: readonly PageBox[], page: number): number {
  const box = boxes[page];
  if (box === undefined) throw new Error('no box');
  return box.top + 300;
}

const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent) === label,
  );

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe('DocumentView keeps the reader place (W5.1a S2)', () => {
  it('keeps the page and the offset within it when the zoom changes through the view command', async () => {
    const ref = createRef<DocumentViewHandle>();
    act(() => {
      root.render(<ViewWithStatus ref={ref} rpc={fakeRpc(10)} handle="doc-1" />);
    });
    await flush();
    const before = computeColumn(sizes(10), 1).boxes;
    const top = pointOn(before, 4);
    scrollTo(top);
    const anchor = viewAnchor(before, top);
    act(() => {
      ref.current?.zoom({ zoom: 2 });
    });
    const after = computeColumn(sizes(10), 2).boxes;
    expect(scroller().scrollTop).toBeCloseTo(
      scrollTopForAnchor(after, anchor ?? { page: 0, yFraction: 0 }) ?? -1,
      6,
    );
    expect(scroller().scrollTop).toBeCloseTo(top * 2, 6);
  });

  it('keeps the place when the zoom changes from the pill preset list', async () => {
    act(() => {
      root.render(<ViewWithStatus rpc={fakeRpc(10)} handle="doc-1" />);
    });
    await flush();
    const before = computeColumn(sizes(10), 1).boxes;
    const top = pointOn(before, 6);
    scrollTo(top);
    act(() => {
      button('Zoom presets')?.click();
    });
    const preset = [...host.querySelectorAll<HTMLButtonElement>('.doc-status-presets button')].find(
      (b) => b.textContent === '200%',
    );
    act(() => {
      preset?.click();
    });
    expect(scroller().scrollTop).toBeCloseTo(top * 2, 6);
  });

  it('keeps the place through a fit width refit after a window resize', async () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'fitWidth' }));
    const originalWidth = window.innerWidth;
    act(() => {
      root.render(<ViewWithStatus rpc={fakeRpc(10)} handle="doc-1" />);
    });
    await flush();
    const zoomBefore = fitWidthZoom(LETTER.width, originalWidth);
    const before = computeColumn(sizes(10), zoomBefore).boxes;
    const top = pointOn(before, 4);
    scrollTo(top);
    const anchor = viewAnchor(before, top);

    window.innerWidth = originalWidth / 2;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    window.innerWidth = originalWidth;

    const zoomAfter = fitWidthZoom(LETTER.width, originalWidth / 2);
    expect(zoomAfter).not.toBe(zoomBefore);
    const after = computeColumn(sizes(10), zoomAfter).boxes;
    expect(scroller().scrollTop).toBeCloseTo(
      scrollTopForAnchor(after, anchor ?? { page: 0, yFraction: 0 }) ?? -1,
      6,
    );
  });

  it('keeps the page in view when the layout switches to two pages', async () => {
    const viewRef = createRef<DocumentViewHandle>();
    act(() => {
      root.render(<ViewWithStatus ref={viewRef} rpc={fakeRpc(10)} handle="doc-1" />);
    });
    await flush();
    const before = computeColumn(sizes(10), 1).boxes;
    const top = pointOn(before, 4);
    scrollTo(top);
    const anchor = viewAnchor(before, top);
    act(() => {
      viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: false });
    });
    const spreads = computeSpreads(sizes(10), 1, false).boxes;
    expect(scroller().scrollTop).toBeCloseTo(
      scrollTopForAnchor(spreads, anchor ?? { page: 0, yFraction: 0 }) ?? -1,
      6,
    );
  });

  it('keeps the focused page mounted when the reader scrolls far away from it', async () => {
    act(() => {
      root.render(<ViewWithStatus rpc={fakeRpc(50)} handle="doc-1" />);
    });
    await flush();
    const column = computeColumn(sizes(50), 1).boxes;
    // Without a focus, page 1 leaves the mounted window when the reader is far down.
    scrollTo(pointOn(column, 40));
    expect(host.querySelector('[data-page="0"]')).toBeNull();

    // With a control on page 1 focused, the page stays mounted as the reader scrolls on.
    scrollTo(0);
    const page = host.querySelector<HTMLElement>('[data-page="0"]');
    if (page === null) throw new Error('page 1 is not mounted');
    const control = document.createElement('button');
    page.append(control);
    act(() => {
      control.focus();
    });
    scrollTo(pointOn(column, 40));
    expect(host.querySelector('[data-page="0"]')).not.toBeNull();
    expect(host.querySelector('[data-page="40"]')).not.toBeNull();
  });
});
