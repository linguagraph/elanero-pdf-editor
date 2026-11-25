// The single-page layout in the view (W5.1a S3): one page is mounted and sized as the page, a jump
// or a step changes the page, and a change of layout keeps the page the reader was on.
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView, type DocumentViewHandle, type DocumentViewState } from './DocumentView';
import { PAGE_GAP_PT, type PageSizePt } from './layout';
import { CSS_PX_PER_POINT } from './zoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PORTRAIT: PageSizePt = { width: 612, height: 792 };
const LANDSCAPE: PageSizePt = { width: 792, height: 612 };
const GAP = PAGE_GAP_PT * CSS_PX_PER_POINT; // at zoom 1

// Only session.pages is answered; the renders and the text layers never are, so the queue does
// not change what the tests read.
function fakeRpc(pages: readonly PageSizePt[]): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({ pages: pages.map((p) => ({ ...p, rotation: 0 })), labels: [] });
      }
      return new Promise(() => undefined);
    }),
  };
  return rpc as unknown as PageRpc;
}

let host: HTMLDivElement;
let root: Root;
let reported: DocumentViewState | undefined;

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

function scrollTo(top: number): void {
  scroller().scrollTop = top;
  act(() => {
    scroller().dispatchEvent(new Event('scroll'));
  });
}

const mountedPages = () =>
  [...host.querySelectorAll<HTMLElement>('.doc-page')].map((el) => Number(el.dataset.page));

// Mounts the view and returns its ref (the handle changes on each render, so tests read ref.current).
async function mount(pages: readonly PageSizePt[]): Promise<RefObject<DocumentViewHandle | null>> {
  const ref = createRef<DocumentViewHandle>();
  act(() => {
    root.render(
      <DocumentView
        ref={ref}
        rpc={fakeRpc(pages)}
        handle="doc-1"
        onViewChange={(state) => {
          reported = state;
        }}
      />,
    );
  });
  await flush();
  return ref;
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  reported = undefined;
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

describe('DocumentView single-page layout (W5.1a S3)', () => {
  it('mounts one page, and the content is that page plus a gap each side', async () => {
    const view = await mount([PORTRAIT, LANDSCAPE, PORTRAIT]);
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    await flush();
    expect(mountedPages()).toEqual([0]);
    const content = host.querySelector<HTMLElement>('.doc-view-content');
    expect(content?.style.width).toBe(`${PORTRAIT.width * CSS_PX_PER_POINT + 2 * GAP}px`);
    expect(content?.style.height).toBe(`${PORTRAIT.height * CSS_PX_PER_POINT + 2 * GAP}px`);
  });

  it('sizes the placeholder of a landscape page to the page itself', async () => {
    const view = await mount([PORTRAIT, LANDSCAPE]);
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    act(() => {
      view.current?.scrollToPage(1);
    });
    await flush();
    expect(mountedPages()).toEqual([1]);
    const page = host.querySelector<HTMLElement>('.doc-page');
    expect(page?.style.width).toBe(`${LANDSCAPE.width * CSS_PX_PER_POINT}px`);
    expect(page?.style.height).toBe(`${LANDSCAPE.height * CSS_PX_PER_POINT}px`);
  });

  it('the steps, the jumps and the reported page move the one page, and stop at the ends', async () => {
    const view = await mount(Array.from({ length: 5 }, () => PORTRAIT));
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    act(() => {
      view.current?.stepPage(1);
    });
    await flush();
    expect(reported?.page).toBe(2);
    expect(mountedPages()).toEqual([1]);
    act(() => {
      view.current?.scrollToPage(4);
    });
    await flush();
    expect(reported?.page).toBe(5);
    expect(mountedPages()).toEqual([4]);
    act(() => {
      view.current?.stepPage(1);
    });
    await flush();
    expect(reported?.page).toBe(5);
    act(() => {
      view.current?.stepPage(-1);
    });
    await flush();
    expect(reported?.page).toBe(4);
    expect(reported?.pageCount).toBe(5);
  });

  it('keeps the page when the reader scrolls within a page taller than the view', async () => {
    const view = await mount([{ width: 612, height: 5000 }, PORTRAIT]);
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    await flush();
    scrollTo(2000);
    expect(reported?.page).toBe(1);
    expect(mountedPages()).toEqual([0]);
    expect(reported?.pageCount).toBe(2);
  });

  it('keeps the page across a change of layout, both ways', async () => {
    const view = await mount(Array.from({ length: 10 }, () => PORTRAIT));
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    act(() => {
      view.current?.scrollToPage(4);
    });
    await flush();
    act(() => {
      view.current?.setLayout({ layout: 'continuous', firstAlone: false });
    });
    await flush();
    expect(reported?.page).toBe(5);
    expect(mountedPages()).toContain(4);
    act(() => {
      view.current?.setLayout({ layout: 'single', firstAlone: false });
    });
    await flush();
    expect(reported?.page).toBe(5);
    expect(mountedPages()).toEqual([4]);
  });

  it('opens in the single page when that is the saved default', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ defaultZoom: 'actual', pageLayout: 'single' }),
    );
    await mount([PORTRAIT, LANDSCAPE, PORTRAIT]);
    expect(reported?.layout).toBe('single');
    expect(mountedPages()).toEqual([0]);
  });
});
