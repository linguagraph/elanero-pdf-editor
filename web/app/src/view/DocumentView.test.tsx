import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';
import { DocumentView } from './DocumentView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Pending = {
  params: Methods['render.page']['params'];
  resolve: (reply: Methods['render.page']['result']) => void;
};

// A fake engine: session.pages answers at once; each render.page waits until the test answers it.
function fakeRpc(pageCount: number) {
  const renders: Pending[] = [];
  const rpc = {
    call: vi.fn((method: string, params: unknown) => {
      if (method === 'session.pages') {
        const pages = Array.from({ length: pageCount }, () => ({
          width: 612,
          height: 792,
          rotation: 0,
        }));
        return Promise.resolve({ pages });
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

beforeEach(() => {
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    const first = renders[0];
    expect(first?.params).toMatchObject({
      handle: 'doc-1',
      page: 0,
      revision: 0,
      rotation: 0,
      annotations: false,
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(renders.length).toBe(2);
  });

  it('zooms with the desktop steps and shows the percentage', async () => {
    const { rpc } = fakeRpc(1);
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await flush();
    expect(host.querySelector('.doc-view-zoom')?.textContent).toBe('100%');
    const zoomIn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Zoom in');
    act(() => {
      zoomIn?.click();
    });
    expect(host.querySelector('.doc-view-zoom')?.textContent).toBe('125%');
  });

  it('shows the loading text while the page sizes are read', () => {
    const rpc = { call: vi.fn(() => new Promise(() => undefined)) } as unknown as PageRpc;
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading pages…');
  });
});

// A one-page document whose render.page answers come from the test, attempt by attempt.
function scriptedRpc(answer: (attempt: number) => Promise<unknown>) {
  let attempts = 0;
  const call = vi.fn((method: string) => {
    if (method === 'session.pages') {
      return Promise.resolve({ pages: [{ width: 612, height: 792, rotation: 0 }] });
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

describe('DocumentView render retries', () => {
  it('asks again after two failures, and draws the third answer', async () => {
    const { rpc, call } = scriptedRpc((attempt) =>
      attempt < 2 ? Promise.reject(new Error('boom')) : Promise.resolve(drawnReply),
    );
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await settle();
    expect(renderCalls(call)).toBe(3);
    expect(host.querySelector('canvas')?.dataset.drawn).toBe('true');
    expect(host.querySelector('.doc-page-error')).toBeNull();
  });

  it('stops after three failures and shows the page as failed', async () => {
    const { rpc, call } = scriptedRpc(() => Promise.reject(new Error('boom')));
    act(() => {
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
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
      root.render(<DocumentView rpc={rpc} handle="doc-1" />);
    });
    await settle();
    expect(renderCalls(call)).toBe(1);
    expect(host.querySelector('.doc-page-error')).toBeNull();
  });
});
