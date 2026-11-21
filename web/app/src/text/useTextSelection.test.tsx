import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Methods } from '../rpc/generated';
import { PageTextLayer } from './PageTextLayer';
import { TextLayerCache, type TextRpc } from './textLayerCache';
import { type TextSelectionOptions, useTextSelection } from './useTextSelection';
import type { TextSelection } from './textSelection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function joinChars(boxes: Float32Array, numbers: Uint32Array): ArrayBuffer {
  const joined = new Uint8Array(boxes.byteLength + numbers.byteLength);
  joined.set(new Uint8Array(boxes.buffer), 0);
  joined.set(new Uint8Array(numbers.buffer), boxes.byteLength);
  return joined.buffer;
}

// Two lines, "ab" and "cd", split by a separator. At zoom 1 a point is 4/3 CSS px per point.
function twoLineLayer(): Methods['text.layer']['result'] {
  return {
    revision: 0,
    text: 'ab\ncd',
    line_rects: [
      { x0: 72, y0: 72, x1: 84, y1: 84 },
      { x0: 72, y0: 84, x1: 84, y1: 96 },
    ],
    chars: joinChars(
      new Float32Array([
        72, 72, 78, 84, 78, 72, 84, 84, 0, 0, 0, 0, 72, 84, 78, 96, 78, 84, 84, 96,
      ]),
      new Uint32Array([0, 0, 0, 1, 1]),
    ),
  };
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

interface HarnessProps {
  readonly cache: TextLayerCache;
  readonly enabled: boolean;
  readonly onPan: () => void;
  readonly onSelection: (selection: TextSelection | null) => void;
}

// A page of two text lines inside a scroller, wired the way DocumentView wires it: a press that
// does not start a selection goes to the pan.
function Harness({ cache, enabled, onPan, onSelection }: HarnessProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const options: TextSelectionOptions = {
    lookup: cache,
    revisionOf: () => 0,
    zoom: 1,
    scroll,
    enabled,
  };
  const pointer = useTextSelection(options);
  onSelection(pointer.selection);
  return (
    <div
      ref={scroll}
      onPointerDown={(event) => {
        if (!pointer.startPress(event)) onPan();
      }}
    >
      <div className="doc-page" data-page={0}>
        <PageTextLayer cache={cache} page={0} revision={0} zoom={1} selection={pointer.selection} />
      </div>
    </div>
  );
}

function pressAt(target: Element, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    }),
  );
}

function moveTo(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
}

function release(): void {
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0 }));
}

// The page element at the origin, so a client point maps to the page's visible space.
function placePage(page: HTMLElement): void {
  page.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 612, bottom: 792, width: 612, height: 792, x: 0, y: 0 }) as DOMRect;
}

let seen: TextSelection | null = null;

async function render(enabled: boolean, onPan: () => void): Promise<TextLayerCache> {
  const call = vi.fn(() => Promise.resolve(twoLineLayer()));
  const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
  await act(async () => {
    root.render(
      <Harness
        cache={cache}
        enabled={enabled}
        onPan={onPan}
        onSelection={(selection) => {
          seen = selection;
        }}
      />,
    );
  });
  await flush();
  placePage(host.querySelector<HTMLElement>('.doc-page') as HTMLElement);
  return cache;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  seen = null;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('useTextSelection', () => {
  it('a drag across two lines builds the model selection with its spans', async () => {
    const onPan = vi.fn();
    const cache = await render(true, onPan);
    const first = host.querySelector('[data-line="0"]') as Element;
    // Press at the left of "a" (72 pt), then drag to the right of "d" on the second line (84 pt).
    await act(async () => {
      pressAt(first, 96, 104);
      moveTo(112, 128);
      release();
    });
    await flush();

    const index = await cache.index(0, 0);
    expect(seen?.anchor).toEqual({ page: 0, index: 0 });
    expect(seen?.focus).toEqual({ page: 0, index: 5 });
    expect(seen?.pageSpans({ get: () => index })).toEqual([{ page: 0, start: 0, end: 5 }]);
    expect(seen?.text({ get: () => index })).toBe('ab\ncd');
    // The visible selection draws from the model: one mark per line.
    expect(host.querySelectorAll('.page-selection-mark')).toHaveLength(2);
    expect(onPan).not.toHaveBeenCalled();
  });

  it('a press off the text pans and clears the selection', async () => {
    const onPan = vi.fn();
    await render(true, onPan);
    const first = host.querySelector('[data-line="0"]') as Element;
    await act(async () => {
      pressAt(first, 96, 104);
      moveTo(112, 128);
      release();
    });
    expect(seen).not.toBeNull();

    const page = host.querySelector('.doc-page') as Element;
    await act(async () => {
      pressAt(page, 5, 5);
      release();
    });
    expect(onPan).toHaveBeenCalledTimes(1);
    expect(seen).toBeNull();
    expect(host.querySelectorAll('.page-selection-mark')).toHaveLength(0);
  });

  it('a press off the text on a page with no selection still pans', async () => {
    const onPan = vi.fn();
    await render(true, onPan);
    await act(async () => {
      pressAt(host.querySelector('.doc-page') as Element, 5, 5);
    });
    expect(onPan).toHaveBeenCalledTimes(1);
    expect(seen).toBeNull();
  });

  it('a press on the text under the Hand tool does not select', async () => {
    const onPan = vi.fn();
    await render(false, onPan);
    await act(async () => {
      pressAt(host.querySelector('[data-line="0"]') as Element, 96, 104);
      moveTo(112, 128);
      release();
    });
    expect(seen).toBeNull();
    expect(onPan).toHaveBeenCalledTimes(1);
  });
});
