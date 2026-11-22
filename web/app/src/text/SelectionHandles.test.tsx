import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Methods } from '../rpc/generated';
import { PageTextLayer } from './PageTextLayer';
import { PageTextIndex } from './pageTextIndex';
import { TextLayerCache, type TextRpc } from './textLayerCache';
import {
  autoScrollDelta,
  HANDLE_BOX_PX,
  type HandlePlacement,
  handlePlacements,
} from './SelectionHandles';
import { TextSelection } from './textSelection';
import { type TextSelectionOptions, useTextSelection } from './useTextSelection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Two lines, "ab" and "cd", split by a separator (the same page the hook tests use). At zoom 1 a
// point is 4/3 CSS px, so line 0 spans y 96..112 px and line 1 spans 112..128 px.
const LAYER = {
  text: 'ab\ncd',
  line_rects: [
    { x0: 72, y0: 72, x1: 84, y1: 84 },
    { x0: 72, y0: 84, x1: 84, y1: 96 },
  ],
  char_boxes: [72, 72, 78, 84, 78, 72, 84, 84, 0, 0, 0, 0, 72, 84, 78, 96, 78, 84, 84, 96],
  line_numbers: [0, 0, 0, 1, 1],
};

function layerReply(): Methods['text.layer']['result'] {
  const boxes = new Float32Array(LAYER.char_boxes);
  const numbers = new Uint32Array(LAYER.line_numbers);
  const joined = new Uint8Array(boxes.byteLength + numbers.byteLength);
  joined.set(new Uint8Array(boxes.buffer), 0);
  joined.set(new Uint8Array(numbers.buffer), boxes.byteLength);
  return {
    revision: 0,
    text: LAYER.text,
    line_rects: LAYER.line_rects,
    chars: joined.buffer,
  };
}

function index(): PageTextIndex {
  return new PageTextIndex({
    text: LAYER.text,
    lineRects: LAYER.line_rects,
    charBoxes: new Float32Array(LAYER.char_boxes),
    lineNumbers: new Uint32Array(LAYER.line_numbers),
  });
}

// Rounds the geometry, so the 4/3 CSS px per point does not leave float noise in the comparison.
function rounded(placed: readonly HandlePlacement[]): HandlePlacement[] {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return placed.map((p) => ({
    end: p.end,
    left: r(p.left),
    top: r(p.top),
    lineHeight: r(p.lineHeight),
  }));
}

describe('handlePlacements', () => {
  // The whole text: anchor at the start of "a", focus after "d".
  const whole = new TextSelection({ page: 0, index: 0 }, { page: 0, index: 5 });

  it('puts the start handle at the first line left edge and the end handle at the last line right edge', () => {
    const placed = handlePlacements(whole, index(), 0, 1);
    // Line 0 at zoom 1: left 96 px, bottom 112 px, height 16 px. The end is line 1 right edge 112 px.
    expect(rounded(placed)).toEqual([
      { end: 'start', left: 96, top: 112, lineHeight: 16 },
      { end: 'end', left: 112, top: 128, lineHeight: 16 },
    ]);
  });

  it('follows the zoom: the same handles at twice the size', () => {
    const placed = handlePlacements(whole, index(), 0, 2);
    expect(rounded(placed)).toEqual([
      { end: 'start', left: 192, top: 224, lineHeight: 32 },
      { end: 'end', left: 224, top: 256, lineHeight: 32 },
    ]);
  });

  it('draws no handle on a page the selection does not reach, or whose index is not ready', () => {
    expect(handlePlacements(whole, index(), 3, 1)).toEqual([]);
    expect(handlePlacements(whole, undefined, 0, 1)).toEqual([]);
  });

  it('draws only the start handle on the start page of a multi-page selection', () => {
    const across = new TextSelection({ page: 0, index: 0 }, { page: 2, index: 5 });
    const first = handlePlacements(across, index(), 0, 1);
    expect(first.map((p) => p.end)).toEqual(['start']);
    expect(handlePlacements(across, index(), 2, 1).map((p) => p.end)).toEqual(['end']);
    expect(handlePlacements(across, index(), 1, 1)).toEqual([]);
  });
});

describe('autoScrollDelta', () => {
  const box = { top: 0, bottom: 500 };

  it('scrolls nothing away from the top and bottom edge zones', () => {
    expect(autoScrollDelta(box, 250)).toBe(0);
  });

  it('scrolls up near the top edge, more the nearer the pointer is to it', () => {
    expect(autoScrollDelta(box, 16)).toBeLessThan(0);
    expect(autoScrollDelta(box, 2)).toBeLessThan(autoScrollDelta(box, 30));
  });

  it('scrolls down near the bottom edge, more the nearer the pointer is to it', () => {
    expect(autoScrollDelta(box, 484)).toBeGreaterThan(0);
    expect(autoScrollDelta(box, 498)).toBeGreaterThan(autoScrollDelta(box, 470));
  });

  it('never scrolls more than 12 px a frame, even past the edge', () => {
    expect(autoScrollDelta(box, -200)).toBe(-12);
    expect(autoScrollDelta(box, 900)).toBe(12);
  });
});

describe('selection handle sizes (source)', () => {
  // jsdom applies no stylesheet, so the rule is read as text (W8.5 S5 does the same for controls).
  const css = readFileSync(join(process.cwd(), 'src/text/textLayer.css'), 'utf8');

  it('gives the handle a 44 x 44 CSS px box, always, with touch-action none', () => {
    const rule = /\.selection-handle \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain(`width: ${HANDLE_BOX_PX}px`);
    expect(rule).toContain(`height: ${HANDLE_BOX_PX}px`);
    expect(rule).toContain('touch-action: none');
    // Not inside a pointer: coarse block, which would leave a fine pointer's handle small.
    expect(css.indexOf('.selection-handle {')).toBeLessThan(css.indexOf('@media (forced-colors'));
  });
});

// A pointer event of a given type, the way the browser sends one (jsdom's MouseEvent carries
// neither pointerId nor pointerType; see useTextSelection.test.tsx).
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

interface HarnessProps {
  readonly cache: TextLayerCache;
  readonly initial: TextSelection;
  readonly onSelection: (selection: TextSelection | null) => void;
  readonly onGestureEnd?: (selection: TextSelection | null) => void;
}

// A page inside a scroller, wired as DocumentView wires it, with the selection set up front.
function Harness({ cache, initial, onSelection, onGestureEnd }: HarnessProps) {
  const scroll = useRef<HTMLDivElement>(null);
  const options: TextSelectionOptions = {
    lookup: cache,
    revisionOf: () => 0,
    zoom: 1,
    scroll,
    enabled: true,
    onGestureEnd,
  };
  const pointerState = useTextSelection(options);
  const { select } = pointerState;
  onSelection(pointerState.selection);
  // Set on mount: the selection is the test's starting point, not a prop the view follows.
  useEffect(() => {
    select(initial);
  }, [select, initial]);
  return (
    <div
      ref={scroll}
      onPointerDown={(event) => {
        pointerState.startPress(event);
      }}
    >
      <div className="doc-page" data-page={0}>
        <PageTextLayer
          cache={cache}
          page={0}
          revision={0}
          zoom={1}
          selection={pointerState.selection}
          handles={pointerState.handles}
          onHandlePress={pointerState.startHandle}
        />
      </div>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root;
let seen: TextSelection | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// A box at the client rect given, for the layout jsdom does not have.
function boxAt(top: number, bottom: number, left = 0, right = 612): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
  } as DOMRect;
}

async function renderHarness(initial: TextSelection, onGestureEnd?: () => void): Promise<void> {
  const call = vi.fn(() => Promise.resolve(layerReply()));
  const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
  await act(async () => {
    root.render(
      <Harness
        cache={cache}
        initial={initial}
        onGestureEnd={onGestureEnd}
        onSelection={(selection) => {
          seen = selection;
        }}
      />,
    );
  });
  await flush();
  // The page element sits at the origin, so client points are page points times 4/3.
  const page = host.querySelector<HTMLElement>('.doc-page') as HTMLElement;
  page.getBoundingClientRect = () => boxAt(0, 792, 0, 612);
  // A touch press on the scroller itself (not on text) makes the touch the last pointer, so the
  // handles show; it selects nothing.
  const scroller = host.firstElementChild as HTMLElement;
  scroller.getBoundingClientRect = () => boxAt(0, 500, 0, 612);
  await act(async () => {
    scroller.dispatchEvent(pointer('pointerdown', 5, 5, 9, 'touch'));
  });
  await flush();
}

// The handle's box placed so its middle lies at the line's middle when the press is at `y`: the
// press then has no grab offset. Line 0's middle is 104 px (the line is 96..112 px).
function placeHandle(end: 'start' | 'end', top: number): HTMLElement {
  const handle = host.querySelector<HTMLElement>(`.selection-handle--${end}`) as HTMLElement;
  handle.getBoundingClientRect = () => boxAt(top, top + HANDLE_BOX_PX);
  return handle;
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
  vi.unstubAllGlobals();
});

describe('selection handles on the page', () => {
  // Anchor before "a", focus after "d": the whole text, "ab" over "cd".
  const whole = new TextSelection({ page: 0, index: 0 }, { page: 0, index: 5 });

  it('shows both handles once a touch was the last pointer, and not before', async () => {
    const call = vi.fn(() => Promise.resolve(layerReply()));
    const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
    await act(async () => {
      root.render(
        <PageTextLayer
          cache={cache}
          page={0}
          revision={0}
          zoom={1}
          selection={whole}
          handles={false}
          onHandlePress={() => {}}
        />,
      );
    });
    await flush();
    expect(host.querySelectorAll('.selection-handle')).toHaveLength(0);
    await act(async () => {
      root.render(
        <PageTextLayer
          cache={cache}
          page={0}
          revision={0}
          zoom={1}
          selection={whole}
          handles
          onHandlePress={() => {}}
        />,
      );
    });
    expect(host.querySelectorAll('.selection-handle')).toHaveLength(2);
    expect(host.querySelector('.selection-handle--start')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('dragging the start handle moves the start and keeps the end as the anchor', async () => {
    await renderHarness(whole);
    expect(host.querySelectorAll('.selection-handle')).toHaveLength(2);
    const handle = placeHandle('start', 112);
    // Press on the start handle at its line's middle (104 px): the grab offset is zero.
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 96, 104, 9, 'touch'));
    });
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', 104, 104, 9, 'touch'));
    });
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', 104, 104, 9, 'touch'));
    });
    // The caret nearest x = 104 px (78 pt) on line 0 is before "b".
    expect(seen?.start).toEqual({ page: 0, index: 1 });
    expect(seen?.end).toEqual({ page: 0, index: 5 });
  });

  it('dragging the end handle with a caret equal to the start keeps the previous selection', async () => {
    await renderHarness(whole);
    const handle = placeHandle('end', 128);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 112, 120, 9, 'touch'));
    });
    // Back to x = 72 pt: the caret is before "a", equal to the start, so the drag refuses it.
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', 96, 104, 9, 'touch'));
    });
    expect(seen?.isEmpty).toBe(false);
    expect(seen?.start).toEqual({ page: 0, index: 0 });
    expect(seen?.end).toEqual({ page: 0, index: 5 });
  });

  it('a handle dragged past the other end swaps the ends (the selection stays whole)', async () => {
    // Anchor "b" before index 1, focus after "c" (index 3): the start handle is on "b".
    const inner = new TextSelection({ page: 0, index: 1 }, { page: 0, index: 3 });
    await renderHarness(inner);
    const handle = placeHandle('start', 112);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 104, 104, 9, 'touch'));
    });
    // Past the end of "d" on line 1 (x 84 pt = 112 px, y 96 pt = 128 px): the caret after "d".
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', 112, 128, 9, 'touch'));
    });
    expect(seen?.start).toEqual({ page: 0, index: 3 });
    expect(seen?.end).toEqual({ page: 0, index: 5 });
  });

  it('the drag ends on pointer up and announces the selection it leaves', async () => {
    const onGestureEnd = vi.fn();
    await renderHarness(whole, onGestureEnd);
    const handle = placeHandle('end', 128);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 112, 120, 9, 'touch'));
      window.dispatchEvent(pointer('pointerup', 112, 120, 9, 'touch'));
    });
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
  });

  it('a second pointer ends the drag and keeps the selection', async () => {
    await renderHarness(whole);
    const handle = placeHandle('end', 128);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 112, 120, 9, 'touch'));
      window.dispatchEvent(pointer('pointerdown', 300, 300, 4, 'touch'));
    });
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', 96, 104, 9, 'touch'));
    });
    // The move after the second pointer is ignored: the selection is the one it was.
    expect(seen?.start).toEqual({ page: 0, index: 0 });
    expect(seen?.end).toEqual({ page: 0, index: 5 });
  });

  it('a mouse press hides the handles', async () => {
    await renderHarness(whole);
    expect(host.querySelectorAll('.selection-handle')).toHaveLength(2);
    const scroller = host.firstElementChild as HTMLElement;
    await act(async () => {
      scroller.dispatchEvent(pointer('pointerdown', 5, 5, 1, 'mouse'));
    });
    expect(host.querySelectorAll('.selection-handle')).toHaveLength(0);
  });

  it('the handle scrolls the view up while the pointer is near the top edge', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await renderHarness(whole);
    const scroller = host.firstElementChild as HTMLElement;
    // jsdom keeps no layout and no scroll position: a plain property stands in for scrollTop.
    Object.defineProperty(scroller, 'scrollTop', { value: 200, writable: true });
    const handle = placeHandle('end', 128);
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 112, 120, 9, 'touch'));
      // Near the scroller's top (its box is 0..500): 5 px from the top edge, inside the zone.
      window.dispatchEvent(pointer('pointermove', 96, 5, 9, 'touch'));
    });
    const before = scroller.scrollTop;
    await act(async () => {
      frames.shift()?.(0);
    });
    expect(scroller.scrollTop).toBeLessThan(before);
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', 96, 5, 9, 'touch'));
    });
  });
});
