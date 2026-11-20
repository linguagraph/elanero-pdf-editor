// The wheel and the scroll keys above the scaled-space limit (W5.1a S4): the spacer moves at the
// scene's rate, so a 100 px wheel moves the scene 100 px, as it does below the limit. The spacer
// takes whole pixels only (a browser reads scrollTop back in whole pixels on a 1x display), so the
// fraction a step owes is carried to the next event; these tests pin that down too.
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
const RATIO = scrollPerScenePixel(LONG_HEIGHT, VIEW);

// The whole pixels a scaled scroll of `px` scroll pixels applies in one step (rounded as the view
// rounds, so a value such as 83.99999999 counts as 84).
const wholeOf = (px: number) => Math.trunc(Math.round(px * 1e6) / 1e6);

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

// Mounts a new view (a new instance, so no remainder is carried in from an earlier one).
async function mount(
  pages: readonly PageSizePt[],
  zoom?: number,
): Promise<RefObject<DocumentViewHandle | null>> {
  act(() => root.unmount());
  host.replaceChildren();
  root = createRoot(host);
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

// Dispatches a key on the scroller and reports whether the view prevented it.
function pressKey(key: string, shiftKey = false, target: EventTarget = scroller()): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, cancelable: true, bubbles: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function wheel(deltaY: number, deltaMode = 0): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, deltaMode, cancelable: true, bubbles: true });
  act(() => {
    scroller().dispatchEvent(event);
  });
  return event;
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

describe('the wheel and the scroll keys above the scaled-space limit', () => {
  it('moves the scene by the wheel amount, not the spacer amount', async () => {
    await mount(LONG, ZOOM);
    expect(LONG_HEIGHT).toBeGreaterThan(SCROLL_SPACE_MAX);
    expect(RATIO).toBeCloseTo(0.12, 1);
    const before = sceneTop();
    const event = wheel(100);
    expect(event.defaultPrevented).toBe(true);
    // The spacer takes the whole pixels of 100 * ratio; the fraction waits for the next event.
    expect(scroller().scrollTop).toBe(wholeOf(100 * RATIO));
    expect(sceneTop() - before).toBeCloseTo(scroller().scrollTop / RATIO, 4);
  });

  it('moves the scene by the ArrowDown amount', async () => {
    await mount(LONG, ZOOM);
    const event = pressKey('ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(wholeOf(40 * RATIO));
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

describe('the page and space keys above the scaled-space limit', () => {
  // A page is seven eighths of the viewport in view pixels; the spacer moves that times its ratio.
  const PAGE_SCROLL = (7 / 8) * VIEW * RATIO;

  it('PageDown moves the scene by seven eighths of the viewport', async () => {
    await mount(LONG, ZOOM);
    const before = sceneTop();
    expect(pressKey('PageDown').defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(wholeOf(PAGE_SCROLL));
    expect(sceneTop() - before).toBeCloseTo(scroller().scrollTop / RATIO, 4);
  });

  it('PageUp moves the scene back by the same amount', async () => {
    await mount(LONG, ZOOM);
    scroller().scrollTop = 1000;
    expect(pressKey('PageUp').defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(1000 - wholeOf(PAGE_SCROLL));
  });

  it('Space moves the same as PageDown', async () => {
    await mount(LONG, ZOOM);
    expect(pressKey(' ').defaultPrevented).toBe(true);
    const space = scroller().scrollTop;
    await mount(LONG, ZOOM);
    pressKey('PageDown');
    expect(space).toBe(scroller().scrollTop);
    expect(space).toBe(wholeOf(PAGE_SCROLL));
  });

  it('Shift+Space moves the same as PageUp', async () => {
    await mount(LONG, ZOOM);
    scroller().scrollTop = 1000;
    expect(pressKey(' ', true).defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(1000 - wholeOf(PAGE_SCROLL));
  });
});

describe('the wheel delta units above the scaled-space limit', () => {
  it('reads a line (deltaMode 1) as 16 px', async () => {
    await mount(LONG, ZOOM);
    wheel(3, 1);
    expect(scroller().scrollTop).toBe(wholeOf(3 * 16 * RATIO));
  });

  it('reads a page (deltaMode 2) as 800 px', async () => {
    await mount(LONG, ZOOM);
    wheel(0.5, 2);
    expect(scroller().scrollTop).toBe(wholeOf(0.5 * 800 * RATIO));
  });
});

describe('small deltas above the scaled-space limit', () => {
  it('keeps a sub-pixel wheel step, so ten steps of 1 px move the spacer 1 px', async () => {
    await mount(LONG, ZOOM);
    // One step is 0.12 spacer pixels: none is whole yet, so the first moves nothing.
    expect(RATIO).toBeGreaterThan(0.1);
    expect(RATIO).toBeLessThan(0.2);
    wheel(1);
    expect(scroller().scrollTop).toBe(0);
    for (let i = 1; i < 10; i += 1) wheel(1);
    // Ten steps of 0.12 make 1.2 spacer pixels: one whole pixel is applied, none lost.
    expect(scroller().scrollTop).toBe(1);
  });

  it('keeps a fraction across keys too, so a small key step is not lost', async () => {
    await mount(LONG, ZOOM);
    // Each ArrowDown at this ratio owes 40 * 0.12 = 4.8 spacer px, so ten of them owe 48 px in total.
    for (let i = 0; i < 10; i += 1) pressKey('ArrowDown');
    expect(scroller().scrollTop).toBe(wholeOf(400 * RATIO));
  });
});

describe('keys that belong to other elements', () => {
  it('leaves the key alone on a focused button inside the scroller', async () => {
    await mount(LONG, ZOOM);
    const button = document.createElement('button');
    scroller().append(button);
    button.focus();
    const event = pressKey(' ', false, button);
    expect(event.defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(0);
  });

  it('scrolls the scene for a key on a non-control element inside a page', async () => {
    await mount(LONG, ZOOM);
    const content = scroller().querySelector<HTMLElement>('[data-page] .doc-page-placeholder');
    if (content === null) throw new Error('no page content');
    const event = pressKey('ArrowDown', false, content);
    expect(event.defaultPrevented).toBe(true);
    expect(scroller().scrollTop).toBe(wholeOf(40 * RATIO));
  });

  it('leaves the key alone on a real button inside a page', async () => {
    await mount(LONG, ZOOM);
    const page = scroller().querySelector<HTMLElement>('[data-page]');
    if (page === null) throw new Error('no page');
    const button = document.createElement('button');
    page.append(button);
    button.focus();
    const event = pressKey(' ', false, button);
    expect(event.defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(0);
  });

  it('leaves an unhandled key alone', async () => {
    await mount(LONG, ZOOM);
    const event = pressKey('a');
    expect(event.defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(0);
  });

  it('leaves Home and End alone', async () => {
    await mount(LONG, ZOOM);
    expect(pressKey('Home').defaultPrevented).toBe(false);
    expect(pressKey('End').defaultPrevented).toBe(false);
    expect(scroller().scrollTop).toBe(0);
  });
});
