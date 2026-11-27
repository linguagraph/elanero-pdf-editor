import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { CommentPageResult, Methods } from '../rpc/generated';
import { PREFS_STORAGE_KEY, readPreferences, writePreferences } from '../prefs/store';
import type { DocumentViewHandle, DocumentViewState } from './DocumentView';
import { computeColumn, computeSpreads, scrollTopForPage } from './layout';
import { ViewWithStatus } from './viewWithStatus.testutil';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Pending = {
  params: Methods['render.page']['params'];
  resolve: (reply: Methods['render.page']['result']) => void;
};

// A fake engine: session.pages answers at once; each render.page waits until the test answers it.
function fakeRpc(pageCount: number, labels: readonly string[] = [], comments?: CommentPageResult) {
  const renders: Pending[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        const pages = Array.from({ length: pageCount }, () => ({
          width: 612,
          height: 792,
          rotation: 0,
        }));
        return Promise.resolve({ pages, labels: [...labels] });
      }
      if (method === 'comments.page' && comments !== undefined) return Promise.resolve(comments);
      // The text layers (W5.4), the redaction list (W7.4b), the page links (W5.3) and the page's
      // comments (W7.1a) are asked for but never answered here: they are not renders.
      if (
        method === 'text.layer' ||
        method === 'redaction.list' ||
        method === 'session.links' ||
        method === 'comments.page'
      ) {
        return new Promise(() => undefined);
      }
      return new Promise((resolve) => {
        renders.push({
          params: params as Methods['render.page']['params'],
          resolve: resolve as Pending['resolve'],
        });
      });
    }),
  };
  return { rpc: rpc as unknown as PageRpc, renders, mock: rpc.call };
}

// Canvas 2D is not in jsdom: a context that records what is drawn.
const context = {
  createImageData: vi.fn((width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  })),
  putImageData: vi.fn(),
};

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// The geometry tests here are at 100 %; the saved default is Fit width otherwise.
// The zoom box of the canvas pill shows the zoom as a percentage.
const zoomValue = () => host.querySelector<HTMLInputElement>('.doc-status-zoom-input')?.value;

function savePreferences(record: Record<string, unknown>): void {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(record));
}

beforeEach(() => {
  savePreferences({ defaultZoom: 'actual' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  context.putImageData.mockClear();
  context.createImageData.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
});

describe('DocumentView with a fake engine', () => {
  it('shows a placeholder at the page size before any pixels arrive', async () => {
    const { rpc, renders } = fakeRpc(3);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const pages = host.querySelectorAll<HTMLElement>('.doc-page');
    expect(pages.length).toBe(2); // the window holds the first two pages of 792 pt
    expect(host.querySelectorAll('.doc-page-placeholder').length).toBe(pages.length);
    expect(pages[0]?.style.width).toBe(`${612 * (4 / 3)}px`);
    expect(pages[0]?.style.height).toBe(`${792 * (4 / 3)}px`);
    expect(host.querySelector('canvas')?.dataset.drawn).toBeUndefined();
    expect(renders.map((r) => r.params.page)).toEqual([0, 1]);
  });

  it('labels each page through t()', async () => {
    const { rpc } = fakeRpc(3);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const labels = [...host.querySelectorAll('.doc-page')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Page 1 of 3', 'Page 2 of 3']);
  });

  it('draws a render reply onto the canvas at its device size', async () => {
    const { rpc, renders } = fakeRpc(3);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const first = renders[0];
    expect(first?.params).toMatchObject({
      handle: 'doc-1',
      page: 0,
      revision: 0,
      rotation: 0,
      annotations: true,
    });
    expect(first?.params.scale_milli).toBeGreaterThan(0);
    await act(async () => {
      first?.resolve({
        width: 4,
        height: 3,
        revision: 0,
        format: 'rgba',
        pixels: new ArrayBuffer(48),
      });
    });
    await flush();
    const canvas = host.querySelectorAll('canvas')[0];
    expect(canvas?.dataset.drawn).toBe('true');
    expect(canvas?.width).toBe(4);
    expect(canvas?.height).toBe(3);
    expect(context.createImageData).toHaveBeenCalledWith(4, 3);
    expect(context.putImageData).toHaveBeenCalledWith(
      expect.objectContaining({ width: 4, height: 3 }),
      0,
      0,
    );
  });

  it('asks again at the reported revision when the page changed', async () => {
    const { rpc, renders } = fakeRpc(1);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    await act(async () => {
      renders[0]?.resolve({
        width: 0,
        height: 0,
        revision: 7,
        format: 'rgba',
        pixels: new ArrayBuffer(0),
      });
    });
    await flush();
    expect(renders.map((r) => r.params.revision)).toEqual([0, 7]);
    await act(async () => {
      renders[1]?.resolve({
        width: 2,
        height: 2,
        revision: 7,
        format: 'rgba',
        pixels: new ArrayBuffer(16),
      });
    });
    await flush();
    expect(host.querySelector('canvas')?.dataset.drawn).toBe('true');
    expect(renders.length).toBe(2);
  });

  it('keeps at most two renders in flight', async () => {
    const { rpc, renders } = fakeRpc(6);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(renders.length).toBe(2);
  });

  it('zooms with the desktop steps and shows the percentage', async () => {
    const { rpc } = fakeRpc(1);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(zoomValue()).toBe('100%');
    const zoomIn = [...host.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Zoom in',
    );
    act(() => {
      zoomIn?.click();
    });
    expect(zoomValue()).toBe('125%');
  });

  it('shows the loading text while the page sizes are read', () => {
    const rpc = { call: vi.fn(() => new Promise(() => undefined)) } as unknown as PageRpc;
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading pages…');
  });
});

// A one-page document whose render.page answers come from the test, attempt by attempt.
function scriptedRpc(answer: (attempt: number) => Promise<unknown>) {
  let attempts = 0;
  const call = vi.fn((method: string) => {
    if (method === 'session.pages') {
      return Promise.resolve({ pages: [{ width: 612, height: 792, rotation: 0 }], labels: [] });
    }
    // The text layer, the redaction list and the page's comments are not renders: they are never
    // answered here and do not use up an attempt.
    if (
      method === 'text.layer' ||
      method === 'redaction.list' ||
      method === 'session.links' ||
      method === 'comments.page'
    ) {
      return new Promise(() => undefined);
    }
    const attempt = attempts;
    attempts += 1;
    return answer(attempt);
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

const drawnReply = {
  width: 2,
  height: 2,
  revision: 0,
  format: 'rgba',
  pixels: new ArrayBuffer(16),
};

// Lets the queue run its retries: each pass is one tick of the view.
async function settle(): Promise<void> {
  for (let pass = 0; pass < 10; pass += 1) await flush();
}

function renderCalls(call: ReturnType<typeof scriptedRpc>['call']): number {
  return call.mock.calls.filter(([method]) => method === 'render.page').length;
}

describe('DocumentView page labels', () => {
  it('reports the labels from session.pages through onViewChange', async () => {
    const { rpc } = fakeRpc(3, ['i', 'ii', '1']);
    const onViewChange = vi.fn();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" onViewChange={onViewChange} />);
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, labels: ['i', 'ii', '1'] }),
    );
  });

  it('reports no labels for a document that has none', async () => {
    const { rpc } = fakeRpc(3);
    const onViewChange = vi.fn();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" onViewChange={onViewChange} />);
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ labels: [] }));
  });
});

describe('DocumentView render retries', () => {
  it('asks again after two failures, and draws the third answer', async () => {
    const { rpc, call } = scriptedRpc((attempt) =>
      attempt < 2 ? Promise.reject(new Error('boom')) : Promise.resolve(drawnReply),
    );
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await settle();
    expect(renderCalls(call)).toBe(3);
    expect(host.querySelector('canvas')?.dataset.drawn).toBe('true');
    expect(host.querySelector('.doc-page-error')).toBeNull();
  });

  it('stops after three failures and shows the page as failed', async () => {
    const { rpc, call } = scriptedRpc(() => Promise.reject(new Error('boom')));
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await settle();
    expect(renderCalls(call)).toBe(3);
    expect(host.querySelector('.doc-page-error')?.textContent).toBe(
      'This page could not be drawn.',
    );
    // No further requests, however long the view waits.
    await settle();
    expect(renderCalls(call)).toBe(3);
  });

  it('asks once and no more when the engine never answers', async () => {
    const { rpc, call } = scriptedRpc(() => new Promise(() => undefined));
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await settle();
    expect(renderCalls(call)).toBe(1);
    expect(host.querySelector('.doc-page-error')).toBeNull();
  });
});

describe('DocumentView layouts and night reading', () => {
  beforeEach(() => {
    window.localStorage.clear();
    savePreferences({ defaultZoom: 'actual' });
  });

  // The layout and night state the view reports. The ribbon's commands drive them through the
  // view's handle (W8 fix 702), so the tests drive the handle and read the reports.
  const viewRef = createRef<DocumentViewHandle>();
  let reported: DocumentViewState | null = null;
  const reportTo = (state: DocumentViewState) => {
    reported = state;
  };
  const pressedOf = (label: string): string | undefined => {
    if (reported === null) return undefined;
    const flags: Record<string, boolean> = {
      'Two pages': reported.layout === 'twoPage',
      'Page 1 alone': reported.firstAlone,
      'Single column': reported.layout === 'continuous',
      'Night reading': reported.night,
    };
    return String(flags[label]);
  };

  it('pairs pages into two-page spreads and puts page 1 alone when asked', async () => {
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    const pages = () => [...host.querySelectorAll<HTMLElement>('.doc-page')];
    expect(pages()).toHaveLength(2);
    const continuousTops = pages().map((p) => p.style.top);
    expect(continuousTops[0]).not.toBe(continuousTops[1]);

    act(() => {
      viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: false });
    });
    expect(pressedOf('Two pages')).toBe('true');
    // Pages 1 and 2 share one spread, so they share a top edge.
    expect(pages()[0]?.style.top).toBe(pages()[1]?.style.top);

    act(() => {
      viewRef.current?.setLayout({ layout: 'twoPage', firstAlone: true });
    });
    expect(pressedOf('Page 1 alone')).toBe('true');
    // Page 1 is alone on the right of the first spread, so page 2 starts the next row.
    expect(pages()[0]?.style.top).not.toBe(pages()[1]?.style.top);
    expect(pages()[1]?.style.left).not.toBe(pages()[0]?.style.left);
  });

  it('turns night reading on and off with a class on the view, and saves the choice', async () => {
    const { rpc } = fakeRpc(1);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    const view = () => host.querySelector('.doc-view');
    expect(view()?.classList.contains('doc-view--night')).toBe(false);

    act(() => {
      viewRef.current?.setNight(!(reported?.night ?? false));
    });
    expect(view()?.classList.contains('doc-view--night')).toBe(true);
    expect(pressedOf('Night reading')).toBe('true');
    expect(readPreferences().nightReading).toBe(true);

    act(() => {
      viewRef.current?.setNight(!(reported?.night ?? false));
    });
    expect(view()?.classList.contains('doc-view--night')).toBe(false);
    expect(readPreferences().nightReading).toBe(false);
  });

  it('starts in night reading when the saved preference says so', async () => {
    writePreferences({ ...readPreferences(), nightReading: true });
    const { rpc } = fakeRpc(1);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    expect(host.querySelector('.doc-view--night')).not.toBeNull();
    window.localStorage.clear();
  });

  it('starts in two pages with page 1 alone for the saved cover layout (W4.5 S2)', async () => {
    savePreferences({ defaultZoom: 'actual', pageLayout: 'twoPageCover' });
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    expect(pressedOf('Two pages')).toBe('true');
    expect(pressedOf('Page 1 alone')).toBe('true');
    expect(pressedOf('Single column')).toBe('false');
  });

  it('starts in two pages without page 1 alone for the saved two-page layout', async () => {
    savePreferences({ defaultZoom: 'actual', pageLayout: 'twoPage' });
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    expect(pressedOf('Two pages')).toBe('true');
    expect(pressedOf('Page 1 alone')).toBe('false');
  });

  it('applies a changed default layout once, and saving other fields keeps the reader choice', async () => {
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    const pressed = (label: string) => pressedOf(label);

    act(() => {
      writePreferences({ ...readPreferences(), pageLayout: 'twoPage' });
    });
    expect(pressed('Two pages')).toBe('true');

    // The reader picks the single column; saving another field must not undo that.
    act(() => {
      viewRef.current?.setLayout({ layout: 'continuous', firstAlone: false });
    });
    act(() => {
      writePreferences({ ...readPreferences(), reduceMotion: true });
    });
    expect(pressed('Single column')).toBe('true');

    // Saving the same default again is not a change, so the reader's choice stays.
    act(() => {
      writePreferences({ ...readPreferences(), pageLayout: 'twoPage' });
    });
    expect(pressed('Single column')).toBe('true');
  });

  it('keeps the current page in view when a changed default layout is applied (W4.5 S2)', async () => {
    const { rpc } = fakeRpc(10);
    const pages: { page: number }[] = [];
    act(() => {
      root.render(
        <ViewWithStatus rpc={rpc} handle="doc-1" onViewChange={(state) => pages.push(state)} />,
      );
    });
    await flush();
    const scroller = host.querySelector<HTMLElement>('.doc-view-scroll');
    if (scroller === null) throw new Error('no scroll element');
    // jsdom has no layout; a plain property lets the test move the view and read what the view wrote.
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });

    // Reader is on page 5 (index 4) in the continuous column.
    const column = computeColumn(
      Array.from({ length: 10 }, () => ({ width: 612, height: 792 })),
      1,
    );
    scroller.scrollTop = scrollTopForPage(column.boxes, 4, 1) ?? -1;
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(pages.at(-1)?.page).toBe(5);

    // The saved default changes to two pages; page 5 must still be the page at the top of the view.
    act(() => {
      writePreferences({ ...readPreferences(), pageLayout: 'twoPage' });
    });
    const spreads = computeSpreads(
      Array.from({ length: 10 }, () => ({ width: 612, height: 792 })),
      1,
      false,
    );
    expect(scroller.scrollTop).toBeCloseTo(scrollTopForPage(spreads.boxes, 4, 1) ?? -1);
    expect(pages.at(-1)?.page).toBe(5);
  });

  it('zooms with Ctrl+wheel through the desktop steps and stops the browser zoom', async () => {
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    const scroll = host.querySelector<HTMLElement>('.doc-view-scroll');
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      scroll?.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(true);
    expect(zoomValue()).toBe('125%');
  });

  it('leaves a plain wheel to the browser', async () => {
    const { rpc } = fakeRpc(2);
    act(() => {
      root.render(
        <ViewWithStatus ref={viewRef} rpc={rpc} handle="doc-1" onViewChange={reportTo} />,
      );
    });
    await flush();
    const scroll = host.querySelector<HTMLElement>('.doc-view-scroll');
    const wheel = new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true });
    act(() => {
      scroll?.dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(false);
    expect(zoomValue()).toBe('100%');
  });
});

// A fake engine with the page sizes given: render.page and render.tile wait until the test answers.
function fakeSizedRpc(sizes: { width: number; height: number }[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: sizes.map((size) => ({ ...size, rotation: 0 })),
          labels: [],
        });
      }
      if (method === 'text.layer' || method === 'redaction.list' || method === 'session.links') {
        return new Promise(() => undefined);
      }
      calls.push({ method, params: params as Record<string, unknown> });
      return new Promise(() => undefined);
    }),
  };
  return { rpc: rpc as unknown as PageRpc, calls };
}

describe('DocumentView tiles (W5.1b)', () => {
  it('draws a page above 4 MP as tiles of its visible part, never as one image', async () => {
    // 1600 pt square at 100 %: about 4.5 MP on the device, so it is tiled.
    const { rpc, calls } = fakeSizedRpc([{ width: 1600, height: 1600 }]);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const renders = calls.filter((call) => call.method.startsWith('render.'));
    expect(renders.some((call) => call.method === 'render.page')).toBe(false);
    // Two requests are in flight; both are tiles of the first row, which is the visible one.
    expect(renders.map((call) => call.method)).toEqual(['render.tile', 'render.tile']);
    for (const call of renders) {
      expect(call.params.tile_px).toBe(1024);
      expect(call.params.tile_y).toBe(0);
    }
  });

  it('draws a page at or under 4 MP as one image, with no tile requests', async () => {
    const { rpc, calls } = fakeSizedRpc([{ width: 612, height: 792 }]);
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const methods = calls.map((call) => call.method);
    expect(methods).toContain('render.page');
    expect(methods).not.toContain('render.tile');
  });
});

describe('DocumentView handle: layout, night and the reported view state (W4.3a S6)', () => {
  it('reports the page count, the fit mode and the layout flags', async () => {
    const { rpc } = fakeRpc(3);
    const onViewChange = vi.fn();
    act(() => {
      root.render(<ViewWithStatus rpc={rpc} handle="doc-1" onViewChange={onViewChange} />);
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageCount: 3, fit: null, firstAlone: false, night: false }),
    );
  });

  it('sets the layout and the cover alone through setLayout', async () => {
    const { rpc } = fakeRpc(3);
    const onViewChange = vi.fn();
    const ref = createRef<DocumentViewHandle>();
    act(() => {
      root.render(
        <ViewWithStatus ref={ref} rpc={rpc} handle="doc-1" onViewChange={onViewChange} />,
      );
    });
    await flush();
    act(() => {
      ref.current?.setLayout({ layout: 'twoPage', firstAlone: true });
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: 'twoPage', firstAlone: true }),
    );
    act(() => {
      ref.current?.setLayout({ layout: 'continuous', firstAlone: false });
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ layout: 'continuous', firstAlone: false }),
    );
  });

  it('turns night reading on through setNight and saves the choice', async () => {
    const { rpc } = fakeRpc(3);
    const onViewChange = vi.fn();
    const ref = createRef<DocumentViewHandle>();
    act(() => {
      root.render(
        <ViewWithStatus ref={ref} rpc={rpc} handle="doc-1" onViewChange={onViewChange} />,
      );
    });
    await flush();
    act(() => {
      ref.current?.setNight(true);
    });
    await flush();
    expect(onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ night: true }));
    expect(readPreferences().nightReading).toBe(true);
  });
});

describe('DocumentView note popup (W7.1a slice 8)', () => {
  const bounds = { x0: 10, y0: 10, x1: 30, y1: 30 };
  const comments: CommentPageResult = {
    revision: 0,
    threads: [
      {
        comment: {
          page: 0,
          name: 'a',
          type: 'Text',
          author: 'Ada',
          contents: 'Check',
          subject: '',
          created: null,
          modified: null,
          state: 'None',
          locked: false,
          rect: bounds,
          bounds,
          hidden: false,
          movable: true,
          resizable: false,
        },
        replies: [],
      },
    ],
  };

  it('does not reopen the note when the tool goes away from Select and back', async () => {
    const { rpc } = fakeRpc(1, [], comments);
    const view = (tool: 'select' | 'hand') => (
      <ViewWithStatus rpc={rpc} handle="doc-1" tool={tool} />
    );
    act(() => {
      root.render(view('select'));
    });
    await flush();
    const layer = host.querySelector<HTMLElement>('.comment-select-layer');
    // jsdom lays nothing out: the layer's box is stubbed to cover the page, as the layer's own tests do.
    if (layer !== null) layer.getBoundingClientRect = () => new DOMRect(0, 0, 2000, 2000);
    const scale = parseFloat(host.querySelector<HTMLElement>('.doc-page')?.style.width ?? '') / 612;
    // A press on the note (page point 15, 15) and its release without a move opens the popup.
    const clientX = 15 * scale;
    await act(async () => {
      layer?.dispatchEvent(
        new MouseEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY: clientX,
        }),
      );
    });
    await act(async () => {
      window.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, clientX, clientY: clientX }),
      );
    });
    expect(host.querySelector('.comment-note-popup')).not.toBeNull();
    act(() => {
      root.render(view('hand'));
    });
    await flush();
    act(() => {
      root.render(view('select'));
    });
    await flush();
    expect(host.querySelector('.comment-note-popup')).toBeNull();
  });
});
