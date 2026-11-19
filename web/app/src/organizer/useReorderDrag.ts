// Pointer-driven drag of organizer pages (W6.1). The hook only tracks the gesture; the rules live in
// reorder.ts, and a completed drop is handed to the panel, which sends the one pages.move call.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  autoScrollStep,
  changesOrder,
  draggedPages,
  dropSlot,
  passedThreshold,
  type CellBox,
  type DropSlot,
} from './reorder';

export interface DragState {
  // Sorted, exactly what pages.move will receive.
  readonly pages: readonly number[];
  readonly slot: DropSlot;
}

export interface ReorderDragOptions {
  readonly gridRef: RefObject<HTMLElement | null>;
  readonly picked: readonly number[];
  readonly total: number;
  // The panel's `busy`: a running drag is cancelled when it turns true, and no new one starts.
  readonly disabled: boolean;
  // Called on drag start when the pressed page was not selected, so it becomes the selection.
  readonly onPick: (page: number) => void;
  // Called once on a drop that changes the order; never for no-ops or cancels.
  readonly onDrop: (pages: readonly number[], before: number) => void;
}

export interface ReorderDrag {
  // null when not dragging (also before the threshold is passed).
  readonly drag: DragState | null;
  // Spread onto the listbox element.
  readonly gridHandlers: {
    readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    readonly onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    readonly onLostPointerCapture: (event: PointerEvent<HTMLElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    readonly onClickCapture: (event: MouseEvent<HTMLElement>) => void;
  };
}

// Set once a drag has started (threshold passed): its measurements and the live pointer.
interface Live {
  readonly cells: CellBox[];
  readonly pages: readonly number[];
  slot: DropSlot;
  clientX: number;
  clientY: number;
}

// One press from pointerdown until pointerup, cancel or capture loss.
interface Press {
  readonly pointerId: number;
  readonly page: number;
  readonly startX: number;
  readonly startY: number;
  readonly grid: HTMLElement;
  live: Live | null;
}

function sameSlot(a: DropSlot, b: DropSlot): boolean {
  return (
    a.before === b.before &&
    a.marker?.index === b.marker?.index &&
    a.marker?.side === b.marker?.side
  );
}

// Cell boxes in scroll-content coordinates, taken once per drag: re-measuring every cell on each
// pointermove would force a layout per move on a large document.
// Releases the pointer capture taken at the drag threshold. Every end path calls it explicitly, so
// capture never outlives the press; it may already be gone (lost, or never taken), hence the catch.
function releaseCapture(press: Press): void {
  try {
    press.grid.releasePointerCapture(press.pointerId);
  } catch {
    // Nothing to release: the pointer is no longer captured by this grid.
  }
}

function measureCells(grid: HTMLElement): CellBox[] {
  const origin = grid.getBoundingClientRect();
  const found: { page: number; box: CellBox }[] = [];
  grid.querySelectorAll<HTMLElement>('[data-page]').forEach((el) => {
    const page = Number(el.dataset.page);
    if (!Number.isInteger(page)) return;
    const rect = el.getBoundingClientRect();
    const left = rect.left - origin.left + grid.scrollLeft;
    const top = rect.top - origin.top + grid.scrollTop;
    found.push({
      page,
      box: {
        left,
        top,
        right: left + rect.width,
        bottom: top + rect.height,
      },
    });
  });
  found.sort((a, b) => a.page - b.page);
  return found.map((entry) => entry.box);
}

// The page under the pointer, when it sits inside this grid's options.
function pageAt(target: EventTarget | null, grid: HTMLElement): number | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest<HTMLElement>('[data-page]');
  if (el === null || !grid.contains(el)) return null;
  const page = Number(el.dataset.page);
  return Number.isInteger(page) ? page : null;
}

export function useReorderDrag(options: ReorderDragOptions): ReorderDrag {
  const { gridRef, picked, total, disabled, onPick, onDrop } = options;
  const [drag, setDrag] = useState<DragState | null>(null);
  const pressRef = useRef<Press | null>(null);
  // The pending auto-scroll frame, if any.
  const frameRef = useRef<number | null>(null);
  // Set after a drag ends, so the click the browser fires on release does not select a page.
  const suppressClickRef = useRef(false);

  // Shows the slot for the press's live pointer; schedules auto-scroll while in an edge band.
  function updateSlot(press: Press): void {
    const live = press.live;
    if (live === null) return;
    const rect = press.grid.getBoundingClientRect();
    const slot = dropSlot(
      live.cells,
      live.clientX - rect.left + press.grid.scrollLeft,
      live.clientY - rect.top + press.grid.scrollTop,
    );
    live.slot = slot;
    setDrag((current) => {
      if (current !== null && current.pages === live.pages && sameSlot(current.slot, slot)) {
        return current;
      }
      return { pages: live.pages, slot };
    });
    const step = autoScrollStep(live.clientY, rect.top, rect.bottom);
    if (step !== 0 && frameRef.current === null) {
      frameRef.current = requestAnimationFrame(() => autoScrollFrame(press));
    }
  }

  function autoScrollFrame(press: Press): void {
    const live = press.live;
    frameRef.current = null;
    if (live === null || pressRef.current !== press) return;
    const rect = press.grid.getBoundingClientRect();
    const step = autoScrollStep(live.clientY, rect.top, rect.bottom);
    if (step === 0) return;
    press.grid.scrollTop += step;
    // The pointer did not move, but the rows under it did: recompute, and keep scrolling if needed.
    updateSlot(press);
  }

  function stopFrame(): void {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }

  // Ends the press. Returns true when it was an active drag (so the caller can swallow the click).
  const cancelDrag = useCallback((): boolean => {
    const press = pressRef.current;
    pressRef.current = null;
    if (press) releaseCapture(press);
    const live = press?.live;
    stopFrame();
    if (!live) return false;
    setDrag(null);
    return true;
  }, []);

  // Turning busy on mid-drag cancels the drag (the panel is about to change the list).
  useEffect(() => {
    if (disabled && cancelDrag()) suppressClickRef.current = true;
  }, [disabled, cancelDrag]);

  // A pending auto-scroll frame must not run after unmount.
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  function onPointerDown(event: PointerEvent<HTMLElement>): void {
    const grid = gridRef.current;
    if (disabled || grid === null || event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    // A second button during a drag must not replace the drag's press.
    if (pressRef.current?.live) return;
    const page = pageAt(event.target, grid);
    if (page === null) return;
    suppressClickRef.current = false;
    pressRef.current = {
      pointerId: event.pointerId,
      page,
      startX: event.clientX,
      startY: event.clientY,
      grid,
      live: null,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLElement>): void {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    if (press.live === null) {
      const dx = event.clientX - press.startX;
      const dy = event.clientY - press.startY;
      if (!passedThreshold(dx, dy)) return;
      try {
        press.grid.setPointerCapture(press.pointerId);
      } catch {
        // The pointer is no longer active; the drag still works with the pointer events it gets.
      }
      const pages = draggedPages(picked, press.page);
      if (!picked.includes(press.page)) onPick(press.page);
      press.live = {
        cells: measureCells(press.grid),
        pages,
        slot: { before: press.page, marker: null },
        clientX: event.clientX,
        clientY: event.clientY,
      };
    }
    press.live.clientX = event.clientX;
    press.live.clientY = event.clientY;
    updateSlot(press);
  }

  function onPointerUp(event: PointerEvent<HTMLElement>): void {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    releaseCapture(press);
    const live = press.live;
    if (live === null) {
      pressRef.current = null;
      return;
    }
    stopFrame();
    pressRef.current = null;
    setDrag(null);
    suppressClickRef.current = true;
    const { before } = live.slot;
    if (changesOrder(total, live.pages, before)) onDrop(live.pages, before);
  }

  function onPointerCancel(event: PointerEvent<HTMLElement>): void {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    if (cancelDrag()) suppressClickRef.current = true;
  }

  function onLostPointerCapture(event: PointerEvent<HTMLElement>): void {
    const press = pressRef.current;
    if (press?.live && press.pointerId === event.pointerId && cancelDrag()) {
      suppressClickRef.current = true;
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    // A key press is followed by a click with no pointerdown (Enter, Space). A flag left by a
    // cancelled drag, which no click follows, must not swallow that click.
    suppressClickRef.current = false;
    if (event.key !== 'Escape') return;
    if (!cancelDrag()) return;
    suppressClickRef.current = true;
    // Only a drag consumes Escape; with no drag the panel or overlay still closes as usual.
    event.stopPropagation();
  }

  function onClickCapture(event: MouseEvent<HTMLElement>): void {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  }

  return {
    drag,
    gridHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onKeyDown,
      onClickCapture,
    },
  };
}
