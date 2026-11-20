// The wheel and the scroll keys above the scaled-space limit (W5.1a S4): the spacer moves at the
// scene's rate, so a 100 px wheel moves the scene 100 px, as it does below the limit.
import { act, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import { computeColumn, type PageSizePt } from './layout';
import { SCROLL_SPACE_MAX, scrollPerScenePixel, sceneTopForScroll } from './scrollSpace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW = 800;
// 1000 pages at this zoom make a layout whose scroll-space ratio is about 0.12.
const ZOOM = 64;
const PAGE: PageSizePt = { width: 612, height: 792 };
const LONG = Array.from({ length: 1000 }, () => PAGE);
const SHORT = Array.from({ length: 3 }, () => PAGE);
const LONG_HEIGHT = computeColumn(LONG, ZOOM).height;

function fakeRpc(pages: readonly PageSizePt[]): PageRpc {
  const rpc = {
    call: vi.fn((method: string) =>
      method === 'session.pages'
        ? Promise.resolve({ pages: pages.map((p) => ({ ...p, rotation: 0 })), labels: [] })
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

async function mount(
  pages: readonly PageSizePt[],
  zoom?: number,
): Promise<RefObject<DocumentViewHandle | null>> {
  const ref = createRef<DocumentViewHandle>();
  act(() => {
    root.render(<DocumentView ref={ref} rpc={fakeRpc(pages)} handle="doc-1" />);
  });
  await flush();
  const element = scroller();
  Object.defineProperty(element, 'clientHeight', { value: VIEW, configurable: true });
  Object.defineProperty(element, 'scrollTop', { value: 0, writable: true, configurable: true });
  if (zoom !== undefined) {
    act(() => ref.current?.zoom({ zoom }));
    await flush();
  }
  return ref;
}

// The scene position at the top of the view, for the spacer's scroll position.
const sceneTop = () => sceneTopForScroll(scroller().scrollTop, LONG_HEIGHT, VIEW);

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the wheel and the scroll keys above the scaled-space limit', () => {
  it('moves the scene by the wheel amount, not the spacer amount', async () => {
    await mount(LONG, ZOOM);
    expect(LONG_HEIGHT).toBeGreaterThan(SCROLL_SPACE_MAX);
    const ratio = scrollPerScenePixel(LONG_HEIGHT, VIEW);
    expect(ratio).toBeCloseTo(0.12, 1);
    const before = sceneTop();
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    act(() => {
      scroller().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBeCloseTo(100 * ratio, 6);
    expect(sceneTop() - before).toBeCloseTo(100, 4);
  });

  it('moves the scene by the ArrowDown amount', async () => {
    await mount(LONG, ZOOM);
    const ratio = scrollPerScenePixel(LONG_HEIGHT, VIEW);
    const before = sceneTop();
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      cancelable: true,
      bubbles: true,
    });
    act(() => {
      scroller().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBeCloseTo(40 * ratio, 6);
    expect(sceneTop() - before).toBeCloseTo(40, 4);
  });

  it('leaves the native wheel alone below the limit', async () => {
    await mount(SHORT);
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    let notPrevented = false;
    act(() => {
      notPrevented = scroller().dispatchEvent(event);
    });
    expect(notPrevented).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(0);
  });
});
