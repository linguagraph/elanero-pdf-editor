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

interface Hooks {
  readonly onGestureEnd?: (selection: TextSelection | null) => void;
  readonly onLongPress?: () => void;
}

interface HarnessProps extends Hooks {
  readonly cache: TextLayerCache;
  readonly enabled: boolean;
  readonly onPan: () => void;
  readonly onSelection: (selection: TextSelection | null) => void;
}

// A page of two text lines inside a scroller, wired the way DocumentView wires it: a press that
// does not start a selection goes to the pan.
function Harness({ cache, enabled, onPan, onSelection, onGestureEnd, onLongPress }: HarnessProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const options: TextSelectionOptions = {
    lookup: cache,
    revisionOf: () => 0,
    zoom: 1,
    scroll,
    enabled,
    onGestureEnd,
    onLongPress,
  };
  const pointer = useTextSelection(options);
  onSelection(pointer.selection);
  return (
    <div
      ref={scroll}
      onPointerDown={(event) => {
        if (!pointer.startPress(event)) onPan();
      }}
      onContextMenu={pointer.contextMenu}
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

async function render(
  enabled: boolean,
  onPan: () => void,
  hooks: Hooks = {},
): Promise<TextLayerCache> {
  const call = vi.fn(() => Promise.resolve(twoLineLayer()));
  const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
  await act(async () => {
    root.render(
      <Harness
        cache={cache}
        enabled={enabled}
        onPan={onPan}
        {...hooks}
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

// A pointer event of a given type, the way the browser sends one: a MouseEvent with the pointer
// fields defined, since jsdom's MouseEvent carries neither pointerId nor pointerType.
function pointer(type: string, x: number, y: number, pointerId: number, pointerType: string) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: pointerType },
  });
  return event;
}

// The touch press, moves and lifts of one finger (a pen has the same events with its type).
function touchDown(target: Element, x: number, y: number, pointerId = 1, type = 'touch'): void {
  target.dispatchEvent(pointer('pointerdown', x, y, pointerId, type));
}

function touchMove(x: number, y: number, pointerId = 1, type = 'touch'): void {
  window.dispatchEvent(pointer('pointermove', x, y, pointerId, type));
}

function touchUp(pointerId = 1, type = 'touch'): void {
  window.dispatchEvent(pointer('pointerup', 0, 0, pointerId, type));
}

function touchCancel(pointerId = 1, type = 'touch'): void {
  window.dispatchEvent(pointer('pointercancel', 0, 0, pointerId, type));
}

// Advances the hold's timer: the test enables fake timers after the render, which needs real ones.
function hold(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('useTextSelection, touch and pen', () => {
  // The first line's "a" (x 72 pt is 96 css px at zoom 1); the second line's "d" is right of 84 pt.
  const FIRST_LINE = { x: 96, y: 104 };
  const SECOND_LINE_END = { x: 112, y: 128 };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a long-press selects the word under the press once the hold is complete', async () => {
    const onPan = vi.fn();
    const onLongPress = vi.fn();
    await render(true, onPan, { onLongPress });
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    hold(499);
    expect(seen).toBeNull();
    hold(1);
    // "ab" is the word under the press: the whole first line before the break.
    expect(seen?.anchor).toEqual({ page: 0, index: 0 });
    expect(seen?.focus).toEqual({ page: 0, index: 2 });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPan).not.toHaveBeenCalled();
  });

  it('a drag after the long-press extends the selection and keeps the word whole', async () => {
    const onGestureEnd = vi.fn();
    await render(true, vi.fn(), { onGestureEnd });
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    hold(500);
    act(() => {
      touchMove(SECOND_LINE_END.x, SECOND_LINE_END.y);
    });
    expect(seen?.anchor).toEqual({ page: 0, index: 0 });
    expect(seen?.focus).toEqual({ page: 0, index: 5 });
    act(() => {
      touchUp();
    });
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
    expect(onGestureEnd.mock.calls[0]?.[0]?.focus).toEqual({ page: 0, index: 5 });
  });

  it('a move past the slop before the hold is a scroll: nothing is selected', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
      touchMove(FIRST_LINE.x + 20, FIRST_LINE.y);
    });
    hold(600);
    expect(seen).toBeNull();
  });

  it('a lift before the hold is a tap: nothing is selected and no gesture ends', async () => {
    const onGestureEnd = vi.fn();
    await render(true, vi.fn(), { onGestureEnd });
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
      touchUp();
    });
    hold(600);
    expect(seen).toBeNull();
    expect(onGestureEnd).not.toHaveBeenCalled();
  });

  it('pointercancel before the hold cancels it', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
      touchCancel();
    });
    hold(600);
    expect(seen).toBeNull();
  });

  it('a second finger during a selection ends the gesture and keeps the selection', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    hold(500);
    act(() => {
      touchDown(first, 300, 300, 2);
      touchMove(SECOND_LINE_END.x, SECOND_LINE_END.y);
    });
    expect(seen?.focus).toEqual({ page: 0, index: 2 });
  });

  it('a second finger during the hold cancels it before the word is selected', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
      touchDown(first, 300, 300, 2);
    });
    hold(600);
    expect(seen).toBeNull();
  });

  it('a pen press follows the touch path', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y, 1, 'pen');
    });
    hold(500);
    expect(seen?.focus).toEqual({ page: 0, index: 2 });
  });

  it('a touchmove is prevented only while a long-press selection runs', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const scroller = host.firstElementChild as HTMLElement;
    const before = new Event('touchmove', { cancelable: true });
    scroller.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    hold(500);
    const during = new Event('touchmove', { cancelable: true });
    scroller.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
  });

  it('the long-press menu is suppressed for the press that selected a word', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const scroller = host.firstElementChild as HTMLElement;
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    hold(500);
    act(() => {
      touchUp();
    });
    // The browser can send its menu after the lift.
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    scroller.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
  });

  it('a contextmenu before the hold selects the word and is suppressed', async () => {
    await render(true, vi.fn());
    vi.useFakeTimers();
    const scroller = host.firstElementChild as HTMLElement;
    const first = host.querySelector('[data-line="0"]') as Element;
    act(() => {
      touchDown(first, FIRST_LINE.x, FIRST_LINE.y);
    });
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      scroller.dispatchEvent(menu);
    });
    expect(menu.defaultPrevented).toBe(true);
    expect(seen?.focus).toEqual({ page: 0, index: 2 });
  });

  it('a context menu with no long-press is left to the browser', async () => {
    await render(true, vi.fn());
    const scroller = host.firstElementChild as HTMLElement;
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    scroller.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(false);
  });
});
