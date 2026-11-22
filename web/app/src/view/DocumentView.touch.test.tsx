import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView } from './DocumentView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The text of the copy tests: page 0 reads "ab" and "cd" on two lines, and every page has it.
function joinChars(boxes: Float32Array, numbers: Uint32Array): ArrayBuffer {
  const joined = new Uint8Array(boxes.byteLength + numbers.byteLength);
  joined.set(new Uint8Array(boxes.buffer), 0);
  joined.set(new Uint8Array(numbers.buffer), boxes.byteLength);
  return joined.buffer;
}

const TEXT_LAYER = {
  revision: 1,
  text: 'ab\ncd',
  line_rects: [
    { x0: 10, y0: 20, x1: 30, y1: 30 },
    { x0: 10, y0: 40, x1: 31, y1: 52 },
  ],
  chars: joinChars(
    new Float32Array([10, 20, 20, 30, 20, 20, 30, 30, 0, 0, 0, 0, 10, 40, 20, 52, 20, 40, 31, 52]),
    new Uint32Array([0, 0, 0, 1, 1]),
  ),
};

function fakeRpc(): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 2 }, () => ({ width: 612, height: 792, rotation: 0 })),
          labels: [],
        });
      }
      if (method === 'text.layer') return Promise.resolve(TEXT_LAYER);
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

beforeEach(async () => {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<DocumentView rpc={fakeRpc()} handle="h" tool="select" />);
  });
  await flush();
  await flush();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
});

// Page k is a box 800 by 1000 CSS px, stacked, so the layer's points (4/3 CSS px each) land on its lines.
function pageBox(index: number): void {
  const page = host.querySelector<HTMLElement>(`.doc-page[data-page="${index}"]`);
  if (page === null) throw new Error(`no page ${index}`);
  const top = index * 1000;
  page.getBoundingClientRect = () =>
    ({ left: 0, top, right: 800, bottom: top + 1000, width: 800, height: 1000 }) as DOMRect;
}

function line(index: number): HTMLElement {
  const span = host.querySelectorAll<HTMLElement>('.doc-page[data-page="0"] .page-text-line')[
    index
  ];
  if (span === undefined) throw new Error(`no text line ${index}`);
  return span;
}

// A pointer event, the way the browser sends one (jsdom's MouseEvent has no pointer fields).
function pointer(
  target: HTMLElement | Window,
  type: string,
  x: number,
  y: number,
  pointerType = 'mouse',
): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: pointerType } });
  act(() => {
    target.dispatchEvent(event);
  });
}

// The first point of "a" (10, 20 pt) and the end of "d" (31, 52 pt), in CSS px at zoom 1.
const START = { x: 10 * (4 / 3) + 1, y: 20 * (4 / 3) + 1 };
const END = { x: 31 * (4 / 3), y: 52 * (4 / 3) };

function liveText(): string {
  return host.querySelector('[role="status"].visually-hidden')?.textContent ?? '';
}

describe('DocumentView selection announcement (W5.4 S1)', () => {
  it('announces the characters after a mouse drag', () => {
    pageBox(0);
    pointer(line(0), 'pointerdown', START.x, START.y);
    pointer(window, 'pointermove', END.x, END.y);
    expect(liveText()).toBe('');
    pointer(window, 'pointerup', END.x, END.y);
    expect(liveText()).toBe('4 characters selected.');
  });

  it('announces the word after a touch long-press, and the drag that follows', () => {
    vi.useFakeTimers();
    pageBox(0);
    pointer(line(0), 'pointerdown', START.x, START.y, 'touch');
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(liveText()).toBe('');
    pointer(window, 'pointermove', END.x, END.y, 'touch');
    pointer(window, 'pointerup', END.x, END.y, 'touch');
    expect(liveText()).toBe('4 characters selected.');
  });

  it('a quick touch swipe announces nothing', () => {
    vi.useFakeTimers();
    pageBox(0);
    pointer(line(0), 'pointerdown', START.x, START.y, 'touch');
    pointer(window, 'pointermove', START.x, START.y + 60, 'touch');
    pointer(window, 'pointerup', START.x, START.y + 60, 'touch');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(liveText()).toBe('');
  });

  it('a drag across two pages announces the characters and the pages', () => {
    pageBox(0);
    pageBox(1);
    pointer(line(0), 'pointerdown', START.x, START.y);
    pointer(window, 'pointermove', END.x, 1000 + END.y);
    pointer(window, 'pointerup', END.x, 1000 + END.y);
    expect(liveText()).toBe('8 characters selected on 2 pages.');
  });
});
