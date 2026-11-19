import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReorderDrag } from './useReorderDrag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Seven 100 px cells in three columns: page i sits at column i % 3, row floor(i / 3). The grid is
// 300 px wide and its client box is `gridBottom` tall; cells move up with the grid's scrollTop.
const COUNT = 7;
let gridBottom = 300;

interface StubProps {
  readonly picked: readonly number[];
  readonly disabled?: boolean;
  readonly onPick?: (page: number) => void;
  readonly onDrop?: (pages: readonly number[], before: number) => void;
  readonly onClick?: (page: number) => void;
}

function Grid({ picked, disabled = false, onPick, onDrop, onClick }: StubProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const { drag, gridHandlers } = useReorderDrag({
    gridRef,
    picked,
    total: COUNT,
    disabled,
    onPick: onPick ?? (() => undefined),
    onDrop: onDrop ?? (() => undefined),
  });
  return (
    <div>
      <div
        role="listbox"
        ref={gridRef}
        data-dragging={drag ? 'true' : undefined}
        data-slot={drag ? String(drag.slot.before) : undefined}
        data-marker={
          drag?.slot.marker ? `${drag.slot.marker.index}:${drag.slot.marker.side}` : undefined
        }
        {...gridHandlers}
      >
        {Array.from({ length: COUNT }, (_, page) => (
          <div
            key={page}
            role="option"
            tabIndex={-1}
            data-page={page}
            aria-selected={picked.includes(page)}
            onClick={() => onClick?.(page)}
          >
            {page}
          </div>
        ))}
      </div>
    </div>
  );
}

// Dispatches a pointer event the way the browser does: a MouseEvent carrying the pointer fields.
function pointer(
  target: Element,
  type: string,
  x: number,
  y: number,
  init: { button?: number; pointerType?: string } = {},
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: init.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: init.pointerType ?? 'mouse' },
  });
  target.dispatchEvent(event);
}

function listbox(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="listbox"]');
  if (el === null) throw new Error('no listbox');
  return el;
}

function option(container: HTMLElement, page: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-page="${page}"]`);
  if (el === null) throw new Error(`no option ${page}`);
  return el;
}

describe('useReorderDrag', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    gridBottom = 300;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom has no layout: cell i is 100 px square, and each cell's client top follows the grid's
    // current scrollTop, so a scroll moves the cells under a fixed pointer.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const grid = listbox(container);
      const scrollTop = Number(Object.getOwnPropertyDescriptor(grid, 'scrollTop')?.value ?? 0);
      if (this === grid) {
        return {
          left: 0,
          top: 0,
          right: 300,
          bottom: gridBottom,
          width: 300,
          height: gridBottom,
        } as DOMRect;
      }
      const page = Number((this as HTMLElement).dataset.page);
      const col = page % 3;
      const row = Math.floor(page / 3);
      const top = row * 100 - scrollTop;
      return {
        left: col * 100,
        top,
        right: col * 100 + 100,
        bottom: top + 100,
        width: 100,
        height: 100,
      } as DOMRect;
    });
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(props: StubProps): void {
    act(() => root.render(<Grid {...props} />));
    // A writable scrollTop on the stub grid: jsdom does not keep one.
    Object.defineProperty(listbox(container), 'scrollTop', {
      value: 0,
      writable: true,
      configurable: true,
    });
  }

  function runFrames(): void {
    const batch = frames.splice(0);
    act(() => batch.forEach((cb) => cb(0)));
  }

  it('a move under the threshold is not a drag, and the click goes through', () => {
    const onPick = vi.fn();
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render({ picked: [], onPick, onDrop, onClick });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 153, 52));
    expect(listbox(container).dataset.dragging).toBeUndefined();
    act(() => pointer(option(container, 1), 'pointerup', 153, 52));
    act(() => option(container, 1).click());
    expect(onPick).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith(1);
  });

  it('dragging an unselected page picks it and drops only that page', () => {
    const onPick = vi.fn();
    const onDrop = vi.fn();
    render({ picked: [], onPick, onDrop });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    expect(onPick).toHaveBeenCalledWith(1);
    // Cell 6 (row 2, left column) right half: the drop lands after the last page.
    expect(listbox(container).dataset.slot).toBe('7');
    expect(listbox(container).dataset.marker).toBe('6:after');
    act(() => pointer(option(container, 1), 'pointerup', 80, 250));
    expect(onDrop).toHaveBeenCalledWith([1], 7);
    expect(listbox(container).dataset.dragging).toBeUndefined();
  });

  it('dragging a selected page carries the whole selection', () => {
    const onPick = vi.fn();
    const onDrop = vi.fn();
    render({ picked: [2, 0], onPick, onDrop });
    act(() => pointer(option(container, 2), 'pointerdown', 250, 50));
    act(() => pointer(option(container, 2), 'pointermove', 120, 50));
    act(() => pointer(option(container, 2), 'pointerup', 120, 50));
    expect(onPick).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith([0, 2], 1);
  });

  it('a drop that changes nothing sends no onDrop', () => {
    const onDrop = vi.fn();
    render({ picked: [], onDrop });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    // Left half of cell 1: before 1, which is the page's own place.
    act(() => pointer(option(container, 1), 'pointermove', 120, 50));
    expect(listbox(container).dataset.slot).toBe('1');
    act(() => pointer(option(container, 1), 'pointerup', 120, 50));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('Escape cancels the drag without a drop, and does not reach the outer handlers', () => {
    const onDrop = vi.fn();
    render({ picked: [], onDrop });
    const outerKey = vi.fn();
    document.body.addEventListener('keydown', outerKey);
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    expect(listbox(container).dataset.dragging).toBe('true');
    act(() => {
      option(container, 1).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(listbox(container).dataset.dragging).toBeUndefined();
    expect(outerKey).not.toHaveBeenCalled();
    act(() => pointer(option(container, 1), 'pointerup', 80, 250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('Escape outside a drag is left alone for the panel', () => {
    render({ picked: [] });
    const outerKey = vi.fn();
    document.body.addEventListener('keydown', outerKey);
    act(() => {
      option(container, 1).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(outerKey).toHaveBeenCalledTimes(1);
  });

  it('pointercancel cancels the drag without a drop', () => {
    const onDrop = vi.fn();
    render({ picked: [], onDrop });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    act(() => pointer(option(container, 1), 'pointercancel', 80, 250));
    expect(listbox(container).dataset.dragging).toBeUndefined();
    act(() => pointer(option(container, 1), 'pointerup', 80, 250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('the click after a drag is swallowed, once', () => {
    const onClick = vi.fn();
    render({ picked: [], onClick });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    act(() => pointer(option(container, 1), 'pointerup', 80, 250));
    act(() => option(container, 1).click());
    expect(onClick).not.toHaveBeenCalled();
    act(() => option(container, 1).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('touch presses are ignored', () => {
    const onPick = vi.fn();
    render({ picked: [], onPick });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50, { pointerType: 'touch' }));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250, { pointerType: 'touch' }));
    expect(onPick).not.toHaveBeenCalled();
    expect(listbox(container).dataset.dragging).toBeUndefined();
  });

  it('a secondary button does not start a drag', () => {
    const onPick = vi.fn();
    render({ picked: [], onPick });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50, { button: 2 }));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    expect(onPick).not.toHaveBeenCalled();
  });

  it('disabled blocks the start of a drag', () => {
    const onPick = vi.fn();
    render({ picked: [], disabled: true, onPick });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    expect(onPick).not.toHaveBeenCalled();
    expect(listbox(container).dataset.dragging).toBeUndefined();
  });

  it('turning disabled mid-drag cancels the drag, and the release drops nothing', () => {
    const onDrop = vi.fn();
    render({ picked: [], onDrop });
    act(() => pointer(option(container, 1), 'pointerdown', 150, 50));
    act(() => pointer(option(container, 1), 'pointermove', 80, 250));
    expect(listbox(container).dataset.dragging).toBe('true');
    render({ picked: [], disabled: true, onDrop });
    expect(listbox(container).dataset.dragging).toBeUndefined();
    act(() => pointer(option(container, 1), 'pointerup', 80, 250));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('auto-scroll in the bottom band scrolls the grid and recomputes the slot', () => {
    // A short grid: its bottom 40 px is the band. The pointer sits in the band at a row-1 cell.
    gridBottom = 150;
    const onDrop = vi.fn();
    render({ picked: [], onDrop });
    act(() => pointer(option(container, 1), 'pointerdown', 50, 50));
    act(() => pointer(option(container, 1), 'pointermove', 50, 145));
    expect(listbox(container).dataset.slot).toBe('4');
    expect(frames.length).toBe(1);
    const grid = listbox(container);
    for (let i = 0; i < 4; i += 1) runFrames();
    expect(grid.scrollTop).toBeGreaterThan(0);
    // Scrolled, the pointer is over row 2, whose only cell is page 6.
    expect(listbox(container).dataset.slot).toBe('7');
    act(() => pointer(option(container, 1), 'pointerup', 50, 145));
    expect(onDrop).toHaveBeenCalledWith([1], 7);
  });

  it('auto-scroll stops once the pointer leaves the band', () => {
    gridBottom = 150;
    render({ picked: [] });
    act(() => pointer(option(container, 1), 'pointerdown', 50, 50));
    act(() => pointer(option(container, 1), 'pointermove', 50, 145));
    act(() => pointer(option(container, 1), 'pointermove', 50, 60));
    runFrames();
    expect(frames.length).toBe(0);
    expect(listbox(container).scrollTop).toBe(0);
  });
});
