// Pointer-driven drag of a bookmark (W5.2 drag and drop). It mirrors the organizer's useReorderDrag:
// mouse and pen only, a 5 px threshold, pointer capture, auto-scroll near the list's edges, and a
// click swallowed after a drag. The hit test lives in drop.ts; a release hands the panel one move.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { autoScrollStep, passedThreshold } from '../organizer/reorder';
import type { OutlineEntry } from '../rpc/generated';
import {
  DEFAULT_INDENT_PX,
  hitAt,
  indentPx,
  resolveDrop,
  rootFontPx,
  type Hit,
  type Resolved,
  type RowBox,
} from './drop';
import type { MoveTarget } from './outlineEdit';
import type { BookmarkRow } from './tree';

// How long the pointer must rest on a closed entry before the drag opens it (W5.2 spring-loading).
export const SPRING_LOAD_MS = 800;
// The depth-1 padding (--space-2) when the row cannot be measured.
const FALLBACK_ORIGIN_PX = 8;

export interface OutlineDragOptions {
  readonly listRef: RefObject<HTMLDivElement | null>;
  // Null while the outline is not loaded.
  readonly entries: readonly OutlineEntry[] | null;
  readonly rows: readonly BookmarkRow[];
  // False while the panel is read-only, busy or renaming: no drag starts.
  readonly enabled: boolean;
  // A running drag is cancelled when busy turns on, the revision changes or the entries change.
  readonly busy: boolean;
  readonly revision: number;
  readonly onStart: (index: number) => void;
  readonly onDrop: (index: number, target: MoveTarget) => void;
  readonly onCancel: () => void;
  // A closed entry the pointer rested on for SPRING_LOAD_MS: the panel expands it (view state).
  readonly onSpringLoad: (index: number) => void;
}

export interface OutlineDrag {
  // null when no drag is running (also before the threshold is passed).
  readonly drag: { readonly index: number; readonly resolved: Resolved | null } | null;
  readonly handlers: {
    readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => void;
    readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
    readonly onClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
  };
}

// One press from pointerdown until the drag ends (or it turns out to be a click).
interface Press {
  readonly pointerId: number;
  readonly index: number;
  readonly startX: number;
  readonly startY: number;
  live: Live | null;
}

// Set once the drag has started: the measured rows, the live pointer and the last result.
interface Live {
  boxes: RowBox[];
  origin: number;
  clientX: number;
  clientY: number;
  resolved: Resolved | null;
  key: string;
  frame: number | null;
  // The indent per level, read from --bookmarks-indent once per drag.
  step: number;
  // The closed entry under the pointer and the timer that opens it.
  spring: { readonly row: number; readonly timer: ReturnType<typeof setTimeout> } | null;
}

function clearSpring(live: Live): void {
  if (live.spring !== null) clearTimeout(live.spring.timer);
  live.spring = null;
}

// Cancels a live drag's frame and spring-load timer. Safe on a null or an idle drag.
function stopTimers(live: Live | null): void {
  if (live === null) return;
  if (live.frame !== null) cancelAnimationFrame(live.frame);
  live.frame = null;
  clearSpring(live);
}

// A string that changes whenever the drop would change what is shown or sent.
function keyOf(resolved: Resolved | null): string {
  if (resolved === null) return '';
  const { result, mark, label } = resolved;
  const target = result.kind === 'move' ? result.target : null;
  return [
    result.kind,
    target?.parent ?? '',
    target?.position ?? '',
    mark?.row ?? '',
    mark?.edge ?? '',
    mark?.depth ?? '',
    label.message,
    label.ref ?? '',
  ].join('|');
}

export function useOutlineDrag(options: OutlineDragOptions): OutlineDrag {
  const [drag, setDrag] = useState<OutlineDrag['drag']>(null);
  const pressRef = useRef<Press | null>(null);
  // Set after a drag ends, so the click the browser fires on release does not navigate.
  const suppressClickRef = useRef(false);
  // The latest render's values: an auto-scroll frame must read the outline the user sees, not the
  // one the drag started with.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const updateRef = useRef<(press: Press) => void>(() => undefined);

  // Measures the visible rows in list-content coordinates, once per drag.
  const measure = useCallback((press: Press): void => {
    const live = press.live;
    const list = latest.current.listRef.current;
    if (live === null || list === null) return;
    const origin = list.getBoundingClientRect();
    live.step = indentPx(
      getComputedStyle(list).getPropertyValue('--bookmarks-indent'),
      rootFontPx(),
    );
    live.boxes = [];
    list.querySelectorAll<HTMLElement>('[data-index]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      const top = rect.top - origin.top + list.scrollTop;
      live.boxes.push({ top, bottom: top + rect.height });
    });
    const first = list.querySelector<HTMLElement>("[data-depth='1']");
    const padding = first === null ? '' : getComputedStyle(first).paddingInlineStart;
    live.origin = Number.parseFloat(padding) || FALLBACK_ORIGIN_PX;
  }, []);

  // Opens the closed entry under the pointer after SPRING_LOAD_MS; any other anchor cancels it.
  const armSpring = useCallback((press: Press, live: Live, hit: Hit): void => {
    const row = hit.kind === 'inside' ? latest.current.rows[hit.row] : undefined;
    const wanted = row !== undefined && row.hasChildren && !row.expanded ? row.index : null;
    if ((live.spring?.row ?? null) === wanted) return;
    clearSpring(live);
    if (wanted === null) return;
    const timer = setTimeout(() => {
      if (pressRef.current !== press || press.live !== live) return;
      if (live.spring?.row !== wanted) return;
      live.spring = null;
      latest.current.onSpringLoad(wanted);
    }, SPRING_LOAD_MS);
    live.spring = { row: wanted, timer };
  }, []);

  // Shows the drop for the live pointer; schedules auto-scroll near the list's edges.
  const update = useCallback(
    (press: Press): void => {
      const live = press.live;
      const { listRef, entries, rows } = latest.current;
      const list = listRef.current;
      if (live === null || list === null || entries === null) return;
      const rect = list.getBoundingClientRect();
      const rtl = getComputedStyle(list).direction === 'rtl';
      const x = rtl ? rect.right - live.clientX : live.clientX - rect.left;
      const y = live.clientY - rect.top + list.scrollTop;
      const hit = hitAt(live.boxes, y);
      armSpring(press, live, hit);
      const resolved = resolveDrop(entries, rows, press.index, hit, x, {
        origin: live.origin,
        step: live.step,
      });
      live.resolved = resolved;
      const key = keyOf(resolved);
      if (key !== live.key) {
        live.key = key;
        setDrag({ index: press.index, resolved });
      }

      const step = autoScrollStep(live.clientY, rect.top, rect.bottom);
      if (step !== 0 && live.frame === null) {
        live.frame = requestAnimationFrame(() => {
          live.frame = null;
          const frameList = latest.current.listRef.current;
          if (frameList === null || pressRef.current !== press || press.live !== live) return;
          const box = frameList.getBoundingClientRect();
          const next = autoScrollStep(live.clientY, box.top, box.bottom);
          if (next === 0) return;
          frameList.scrollTop += next;
          // The pointer did not move, but the rows under it did: recompute.
          updateRef.current(press);
        });
      }
    },
    [armSpring],
  );
  // The frame above reaches the current update through this ref (update cannot name itself).
  useLayoutEffect(() => {
    updateRef.current = update;
  }, [update]);

  // Ends the press. Returns true when it was an active drag (so the caller swallows the click).
  const endDrag = useCallback((): boolean => {
    const press = pressRef.current;
    pressRef.current = null;
    const live = press?.live ?? null;
    if (press !== null) {
      try {
        latest.current.listRef.current?.releasePointerCapture(press.pointerId);
      } catch {
        // The capture was never taken, or is already gone.
      }
    }
    stopTimers(live);
    if (live === null) return false;
    setDrag(null);
    return true;
  }, []);

  // A drag that outlives the outline it was planned on is cancelled: busy, a new revision, or new
  // entries (the panel reloads them after an edit or an Undo).
  useEffect(() => {
    if (endDrag()) suppressClickRef.current = true;
  }, [options.busy, options.revision, options.entries, endDrag]);

  // Measurements are stale once the visible rows change (a row was opened or closed).
  const rowsKey = options.rows.map((row) => `${row.index}${row.expanded ? '+' : ''}`).join(',');
  useLayoutEffect(() => {
    const press = pressRef.current;
    if (press?.live) {
      measure(press);
      update(press);
    }
  }, [rowsKey, measure, update]);

  // Timers and frames must not outlive the panel.
  useEffect(() => () => stopTimers(pressRef.current?.live ?? null), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    const { enabled, listRef } = latest.current;
    const list = listRef.current;
    if (!enabled || list === null || event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    // A second button during a drag must not replace the drag's press.
    if (pressRef.current?.live) return;
    // The rename field keeps its own pointer and keyboard.
    if (event.target instanceof Element && event.target.closest('input') !== null) return;
    const row =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[data-index]') : null;
    if (row === null || !list.contains(row)) return;
    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) return;
    suppressClickRef.current = false;
    pressRef.current = {
      pointerId: event.pointerId,
      index,
      startX: event.clientX,
      startY: event.clientY,
      live: null,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    if (press.live === null) {
      const dx = event.clientX - press.startX;
      const dy = event.clientY - press.startY;
      if (!passedThreshold(dx, dy)) return;
      try {
        latest.current.listRef.current?.setPointerCapture(press.pointerId);
      } catch {
        // The pointer is no longer active; the drag still follows the events it gets.
      }
      press.live = {
        boxes: [],
        origin: FALLBACK_ORIGIN_PX,
        clientX: event.clientX,
        clientY: event.clientY,
        resolved: null,
        key: '',
        frame: null,
        step: DEFAULT_INDENT_PX,
        spring: null,
      };
      measure(press);
      latest.current.onStart(press.index);
    }
    press.live.clientX = event.clientX;
    press.live.clientY = event.clientY;
    update(press);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    const live = press.live;
    if (live === null) {
      pressRef.current = null;
      return;
    }
    const resolved = live.resolved;
    endDrag();
    suppressClickRef.current = true;
    if (resolved?.result.kind === 'move') {
      latest.current.onDrop(press.index, resolved.result.target);
    }
  };

  const onPointerCancel = (event: PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    if (press === null || press.pointerId !== event.pointerId) return;
    if (endDrag()) suppressClickRef.current = true;
  };

  const onLostPointerCapture = (event: PointerEvent<HTMLDivElement>): void => {
    const press = pressRef.current;
    if (press?.live && press.pointerId === event.pointerId && endDrag()) {
      suppressClickRef.current = true;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // A key press is followed by a click with no pointerdown; a flag left by a cancelled drag must
    // not swallow that click.
    if (event.key !== 'Escape') {
      suppressClickRef.current = false;
      return;
    }
    if (!pressRef.current?.live) return;
    endDrag();
    suppressClickRef.current = true;
    latest.current.onCancel();
    // Only a drag consumes Escape; with no drag the panel still closes as usual.
    event.stopPropagation();
  };

  const onClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  return {
    drag,
    handlers: {
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
