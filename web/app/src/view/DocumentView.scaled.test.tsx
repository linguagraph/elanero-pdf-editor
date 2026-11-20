// The view above the scaled-space limit (W5.1a S4): 1000 pages at 6400 % make a layout past 8 M CSS
// px. The spacer stops at the limit, the last page is reachable, and the mounted pages stay bounded.
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import { PAGE_GAP_PT, computeColumn, scrollTopForPage, type PageSizePt } from './layout';
import { SCROLL_SPACE_MAX, scrollTopForSceneTop } from './scrollSpace';
import { CSS_PX_PER_POINT } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = 800;
const ZOOM = 64;
const PAGE: PageSizePt = { width: 612, height: 792 };
const PAGES = Array.from({ length: 1000 }, () => PAGE);
const LAYOUT = computeColumn(PAGES, ZOOM);

// Only session.pages is answered; the renders and the text layers never are.
function fakeRpc(): PageRpc {
  const rpc = {
    call: vi.fn((method: string) =>
      method === 'session.pages'
        ? Promise.resolve({ pages: PAGES.map((p) => ({ ...p, rotation: 0 })), labels: [] })
        : new Promise(() => undefined),
    ),
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

function scroller(): HTMLElement {
  const element = host.querySelector<HTMLElement>('.doc-view-scroll');
  if (element === null) throw new Error('no scroll element');
  return element;
}

// jsdom has no layout: the viewport height and the scroll position are plain properties here.
function scrollTo(top: number): void {
  scroller().scrollTop = top;
  act(() => {
    scroller().dispatchEvent(new Event('scroll'));
  });
}

const mountedPages = () =>
  [...host.querySelectorAll<HTMLElement>('.doc-page')].map((el) => Number(el.dataset.page));

// Mounts the long document at 6400 % and gives the scroller a viewport height.
async function mountLong(): Promise<RefObject<DocumentViewHandle | null>> {
  const ref = createRef<DocumentViewHandle>();
  act(() => {
    root.render(<DocumentView ref={ref} rpc={fakeRpc()} handle="doc-1" />);
  });
  await flush();
  const element = scroller();
  Object.defineProperty(element, 'clientHeight', { value: VIEW, configurable: true });
  Object.defineProperty(element, 'scrollTop', { value: 0, writable: true, configurable: true });
  act(() => ref.current?.zoom({ zoom: ZOOM }));
  await flush();
  return ref;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the view above the scaled-space limit', () => {
  it('stops the spacer at the limit and stages the pages', async () => {
    await mountLong();
    expect(LAYOUT.height).toBeGreaterThan(SCROLL_SPACE_MAX);
    const content = host.querySelector<HTMLElement>('.doc-view-content');
    expect(parseFloat(content?.style.height ?? '0')).toBe(SCROLL_SPACE_MAX);
    expect(host.querySelector('.doc-view-stage--scaled')).not.toBeNull();
  });

  it('reaches the last page and keeps the page at the top of the view', async () => {
    const ref = await mountLong();
    act(() => ref.current?.scrollToPage(999));
    await flush();
    const target = scrollTopForSceneTop(
      scrollTopForPage(LAYOUT.boxes, 999, ZOOM) ?? -1,
      LAYOUT.height,
      VIEW,
    );
    expect(scroller().scrollTop).toBeCloseTo(target, 3);
    expect(mountedPages()).toContain(999);
    // The page's top sits half a page gap below the viewport top, as the continuous column aims it.
    const page = host.querySelector<HTMLElement>('.doc-page[data-page="999"]');
    expect(parseFloat(page?.style.top ?? 'NaN')).toBeCloseTo(
      (PAGE_GAP_PT / 2) * ZOOM * CSS_PX_PER_POINT,
      0,
    );
  });

  it('mounts a bounded window at the top, the middle and the end', async () => {
    await mountLong();
    for (const top of [0, (SCROLL_SPACE_MAX - VIEW) / 2, SCROLL_SPACE_MAX - VIEW]) {
      act(() => scrollTo(top));
      await flush();
      expect(mountedPages().length).toBeGreaterThan(0);
      expect(mountedPages().length).toBeLessThanOrEqual(12);
    }
    expect(mountedPages()).toContain(999);
  });
});
