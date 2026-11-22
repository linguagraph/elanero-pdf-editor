// The pointer side of the text selection (W5.4 S3, the pointer-drag slice). A press on a text span
// starts a TextSelection in the model, and a drag moves its focus to the caret nearest the pointer,
// on whichever page the pointer is over, so a drag across a page gap or across pages still selects.
// A press that starts off text clears the selection and returns false, so the caller pans with it,
// as the desktop does (W1.4 section 10, decision D2). The selection is read-only: no Command.
//
// A touch or pen press (W5.4 S1) takes the long-press path of touchPress.ts instead: a hold on text
// selects the word under it, and a drag after that extends the selection with the word kept whole.
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { HIT_TOLERANCE, type PageTextIndex } from './pageTextIndex';
import type { AreaPoint } from './textLayer';
import { extendFromWord, type TextPos, TextSelection } from './textSelection';
import {
  IDLE,
  LONG_PRESS_MS,
  stepTouch,
  type TouchGesture,
  type TouchInput,
  touchHitPoints,
} from './touchPress';

// The index of a page at its revision once it has arrived (TextLayerCache.readyIndex satisfies it).
export interface TextIndexLookup {
  readyIndex(page: number, revision: number): PageTextIndex | undefined;
}

export interface TextSelectionOptions {
  readonly lookup: TextIndexLookup;
  readonly revisionOf: (page: number) => number;
  readonly zoom: number;
  // The element that holds the pages; the pages inside it are `.doc-page` elements with data-page.
  readonly scroll: RefObject<HTMLElement | null>;
  // False when a press must not select (any tool but Select, or a gesture tool): startPress then
  // does nothing and returns false.
  readonly enabled: boolean;
  // Called when a gesture that selected text ends (a mouse drag, a touch or pen selection), with the
  // selection it leaves. The live region announces its size from it (W5.4 section 6).
  readonly onGestureEnd?: (selection: TextSelection | null) => void;
  // Called when a long-press selects a word, so the press is no longer a link tap (section 2).
  readonly onLongPress?: () => void;
}

export interface TextSelectionPointer {
  // The model's selection, or null when none is made.
  readonly selection: TextSelection | null;
  // Called from the pointer-down of the pages' container. True when the press started a selection
  // or belongs to a touch gesture (the caller must not pan); false otherwise, and then the caller pans.
  startPress(event: ReactPointerEvent<HTMLElement>): boolean;
  // Called from the context-menu event of the pages' container. Prevents the browser's long-press
  // menu for the press that selected a word (section 5).
  contextMenu(event: ReactMouseEvent<HTMLElement>): void;
  // Sets the model's selection, or clears it with null (Select All selects a page's whole text).
  select(selection: TextSelection | null): void;
}

export function useTextSelection(options: TextSelectionOptions): TextSelectionPointer {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  // The drag's listeners read the latest options, not the ones of the press that started them.
  const latest = useRef(options);
  const stopDrag = useRef<(() => void) | null>(null);
  // The selection as last set. A listener reads it at the gesture's end, a render too late for state.
  const selected = useRef<TextSelection | null>(null);
  // The touch gesture (touchPress.ts), the caret its press landed on, the word a long-press selected
  // and the hold's timer.
  const gesture = useRef<TouchGesture>(IDLE);
  const pressCaret = useRef<TextPos | null>(null);
  const word = useRef<TextSelection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set when a long-press selected a word and cleared by the next press. The browser can send its
  // long-press menu after the lift, and that menu must still be suppressed.
  const longPressed = useRef(false);

  const commit = useCallback((next: TextSelection | null) => {
    selected.current = next;
    setSelection(next);
  }, []);

  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => () => stopDrag.current?.(), []);
  // The scroller's touchmove, not passive, so a drag after a long-press does not scroll (section 2).
  // Attached after every render: the scroller can remount when the view changes its page set.
  useEffect(() => {
    const element = options.scroll.current;
    if (element === null) return;
    const guard = (event: TouchEvent) => {
      if (gesture.current.phase === 'selecting') event.preventDefault();
    };
    element.addEventListener('touchmove', guard, { passive: false });
    return () => element.removeEventListener('touchmove', guard);
  });

  function clearTimer(): void {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  // Feeds one input to the touch gesture and runs the effect it returns.
  function feed(input: TouchInput): void {
    const step = stepTouch(gesture.current, input);
    gesture.current = step.gesture;
    const now = latest.current;
    switch (step.effect) {
      case 'arm':
        timer.current = setTimeout(() => {
          timer.current = null;
          feed({ type: 'timer' });
        }, LONG_PRESS_MS);
        break;
      case 'selectWord':
        clearTimer();
        word.current = wordAtPress(now);
        longPressed.current = true;
        commit(word.current);
        now.onLongPress?.();
        break;
      case 'extend': {
        if (input.type !== 'move' || word.current === null) break;
        const focus = caretAtPointer(now, input.x, input.y);
        if (focus !== null) commit(extendFromWord(word.current, focus));
        break;
      }
      case 'tap':
        stopDrag.current?.();
        commit(null);
        break;
      case 'end':
        stopDrag.current?.();
        now.onGestureEnd?.(selected.current);
        break;
      case 'stop':
        stopDrag.current?.();
        break;
      case 'none':
        break;
    }
  }

  // A touch or pen press (W5.4 S1). Only a press on text starts a gesture; the press itself is not
  // prevented, so the browser still scrolls if the finger moves.
  function startTouch(event: ReactPointerEvent<HTMLElement>, now: TextSelectionOptions): boolean {
    const active = gesture.current;
    if (active.phase !== 'idle') {
      // A second pointer during a gesture is a pinch: it ends the gesture and keeps the selection.
      if (event.pointerId !== active.pointerId) feed({ type: 'second' });
      return true;
    }
    const caret = caretUnderPress(
      now,
      event.target,
      event.clientX,
      event.clientY,
      touchHitPoints(now.zoom),
    );
    if (caret === null) return false;
    stopDrag.current?.();
    pressCaret.current = caret;
    const onMove = (moved: PointerEvent) =>
      feed({ type: 'move', pointerId: moved.pointerId, x: moved.clientX, y: moved.clientY });
    const onUp = (up: PointerEvent) => feed({ type: 'up', pointerId: up.pointerId });
    const onCancel = (cancel: PointerEvent) =>
      feed({ type: 'cancel', pointerId: cancel.pointerId });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    stopDrag.current = () => {
      clearTimer();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      gesture.current = IDLE;
      stopDrag.current = null;
    };
    feed({
      type: 'press',
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      onText: true,
    });
    return true;
  }

  // The word under the press, as a selection, or null when the press's index is gone.
  function wordAtPress(now: TextSelectionOptions): TextSelection | null {
    const caret = pressCaret.current;
    if (caret === null) return null;
    const index = indexOf(now, caret.page);
    if (index === undefined) return null;
    const [from, to] = index.wordRange(caret.index);
    return new TextSelection({ page: caret.page, index: from }, { page: caret.page, index: to });
  }

  return {
    selection,
    select: commit,
    contextMenu(event) {
      if (gesture.current.phase === 'pending') feed({ type: 'contextmenu' });
      if (longPressed.current) event.preventDefault();
    },
    startPress(event) {
      const current = latest.current;
      longPressed.current = false;
      if (!current.enabled || event.button !== 0) return false;
      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        return startTouch(event, current);
      }
      const anchor = caretUnderPress(
        current,
        event.target,
        event.clientX,
        event.clientY,
        HIT_TOLERANCE,
      );
      if (anchor === null) {
        commit(null);
        return false;
      }
      // No native selection or image drag: the model draws the selection.
      event.preventDefault();
      stopDrag.current?.();
      const start = { page: anchor.page, index: anchor.index };
      commit(new TextSelection(start, start));
      const move = (moved: PointerEvent) => {
        const focus = caretAtPointer(latest.current, moved.clientX, moved.clientY);
        if (focus !== null) commit(new TextSelection(start, focus));
      };
      const end = () => {
        stopDrag.current?.();
        latest.current.onGestureEnd?.(selected.current);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      stopDrag.current = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        stopDrag.current = null;
      };
      return true;
    },
  };
}

// The caret under a press: only a press on a text span (within the tolerance) starts one.
function caretUnderPress(
  current: TextSelectionOptions,
  target: EventTarget | null,
  x: number,
  y: number,
  tolerance: number,
): TextPos | null {
  const span = target instanceof Element ? target.closest('.page-text-line') : null;
  const pageElement = span?.closest<HTMLElement>('[data-page]') ?? null;
  if (pageElement === null) return null;
  const page = Number(pageElement.dataset.page);
  const index = indexOf(current, page);
  if (index === undefined) return null;
  const at = index.hitTest(pagePoint(pageElement, x, y, current.zoom), tolerance);
  return at === null ? null : { page, index: at };
}

// The caret nearest the pointer, on the page the pointer is over (or the nearest page in a gap).
function caretAtPointer(current: TextSelectionOptions, x: number, y: number): TextPos | null {
  const scroll = current.scroll.current;
  if (scroll === null) return null;
  const page = pageAtPoint(scroll, x, y);
  if (page === null) return null;
  const index = indexOf(current, page.page);
  if (index === undefined) return null;
  const at = index.nearest(pagePoint(page.element, x, y, current.zoom));
  return at === null ? null : { page: page.page, index: at };
}

function indexOf(current: TextSelectionOptions, page: number): PageTextIndex | undefined {
  return current.lookup.readyIndex(page, current.revisionOf(page));
}

// The page under a point, or the nearest one when the point is in a gap between pages.
function pageAtPoint(
  scroll: HTMLElement,
  x: number,
  y: number,
): { page: number; element: HTMLElement } | null {
  let best: { page: number; element: HTMLElement; distance: number } | null = null;
  for (const element of Array.from(scroll.querySelectorAll<HTMLElement>('.doc-page[data-page]'))) {
    const rect = element.getBoundingClientRect();
    const distance =
      Math.max(rect.left - x, 0, x - rect.right) + Math.max(rect.top - y, 0, y - rect.bottom);
    if (best === null || distance < best.distance) {
      best = { page: Number(element.dataset.page), element, distance };
    }
  }
  return best === null ? null : { page: best.page, element: best.element };
}

// A client point in the page's visible space, in points (the layer's and the index's unit).
function pagePoint(element: HTMLElement, x: number, y: number, zoom: number): AreaPoint {
  const rect = element.getBoundingClientRect();
  const scale = zoom * CSS_PX_PER_POINT;
  return { x: (x - rect.left) / scale, y: (y - rect.top) / scale };
}
