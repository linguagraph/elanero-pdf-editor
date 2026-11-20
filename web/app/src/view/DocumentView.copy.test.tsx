import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { ToastStore } from '../feedback/toasts';
import { copySelectedText } from '../text/copy';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { DocumentView, type DocumentViewHandle } from './DocumentView';
import type { ViewTool } from './viewTool';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Page 0 reads "ab" and "cd" on two lines (the layer of copy.test.ts); each page has the same text.
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

// Session.pages and text.layer answer at once; render.page never answers, which keeps the test to
// the view (the page images are not needed to select text).
function fakeRpc(): PageRpc {
  const rpc = {
    call: vi.fn((method: string) => {
      if (method === 'session.pages') {
        return Promise.resolve({
          pages: Array.from({ length: 3 }, () => ({ width: 612, height: 792, rotation: 0 })),
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
let handle = createRef<DocumentViewHandle>();

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function render(tool: ViewTool): void {
  act(() => {
    root.render(<DocumentView ref={handle} rpc={fakeRpc()} handle="h" tool={tool} />);
  });
}

beforeEach(async () => {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ defaultZoom: 'actual' }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  handle = createRef<DocumentViewHandle>();
  render('select');
  await flush();
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.getSelection()?.removeAllRanges();
});

// jsdom has no layout: page 0 is a box at the origin, 800 by 1000 CSS px, so the points of the
// layer (4/3 CSS px each at zoom 1) land on its lines.
function pageZero(): HTMLElement {
  const page = host.querySelector<HTMLElement>('.doc-page[data-page="0"]');
  if (page === null) throw new Error('no page 0');
  page.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 1000, width: 800, height: 1000 }) as DOMRect;
  return page;
}

function line(index: number): HTMLElement {
  const span = host.querySelectorAll<HTMLElement>('.doc-page[data-page="0"] .page-text-line')[
    index
  ];
  if (span === undefined) throw new Error(`no text line ${index}`);
  return span;
}

function pointer(element: HTMLElement | Window, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } });
  act(() => {
    element.dispatchEvent(event);
  });
}

// A native selection over page 0's lines: from the start of line `from` to the end of line `to`.
function nativeSelect(from: number, to: number): Selection {
  const range = document.createRange();
  const start = line(from).firstChild;
  const end = line(to).firstChild;
  if (!(start instanceof Text) || !(end instanceof Text)) throw new Error('no text node');
  range.setStart(start, 0);
  range.setEnd(end, end.length);
  const selection = window.getSelection();
  if (selection === null) throw new Error('no selection');
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

// Copy as App wires it: the model's text first (selectedText), then the browser's selection.
function copy(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(() => Promise.resolve());
  const store = { push: vi.fn() } as unknown as ToastStore;
  copySelectedText({
    selection: window.getSelection(),
    lookup: (page) => handle.current?.cachedLines(page),
    clipboard: { writeText },
    store,
    modelText: () => handle.current?.selectedText() ?? null,
  });
  return writeText;
}

describe('DocumentView copy with the Select tool (W5.4)', () => {
  it('copies a drag made under Select, then the native selection once Hand is chosen', async () => {
    pageZero();
    // A press on "a" (10, 20 pt) and a drag to the end of "d" (31, 52 pt), 4/3 CSS px per point.
    pointer(line(0), 'pointerdown', 10 * (4 / 3) + 1, 20 * (4 / 3) + 1);
    pointer(window, 'pointermove', 31 * (4 / 3), 52 * (4 / 3));
    pointer(window, 'pointerup', 31 * (4 / 3), 52 * (4 / 3));
    expect(handle.current?.selectedText()).toBe('ab\ncd');

    render('hand');
    await flush();
    expect(handle.current?.selectedText()).toBeNull();
    nativeSelect(0, 0);
    expect(copy()).toHaveBeenCalledWith('ab');
  });

  it('copies the native selection, not a Select All left over after the tool changed', async () => {
    pageZero();
    act(() => handle.current?.selectPageText());
    expect(handle.current?.selectedText()).toBe('ab\ncd');

    render('hand');
    await flush();
    expect(handle.current?.selectedText()).toBeNull();
    nativeSelect(1, 1);
    expect(copy()).toHaveBeenCalledWith('cd');
  });
});
