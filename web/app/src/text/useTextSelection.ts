// The pointer side of the text selection (W5.4 S3, the pointer-drag slice). A press on a text span
// starts a TextSelection in the model, and a drag moves its focus to the caret nearest the pointer,
// on whichever page the pointer is over, so a drag across a page gap or across pages still selects.
// A press that starts off text clears the selection and returns false, so the caller pans with it,
// as the desktop does (W1.4 section 10, decision D2). The selection is read-only: no Command.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CSS_PX_PER_POINT } from '../view/zoom';
import { HIT_TOLERANCE, type PageTextIndex } from './pageTextIndex';
import type { AreaPoint } from './textLayer';
import { type TextPos, TextSelection } from './textSelection';

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
}

export interface TextSelectionPointer {
  // The model's selection, or null when none is made.
  readonly selection: TextSelection | null;
  // Called from the pointer-down of the pages' container. True when the press started a selection
  // (the caller must not pan); false otherwise, and then the caller pans.
  startPress(event: ReactPointerEvent<HTMLElement>): boolean;
}

export function useTextSelection(options: TextSelectionOptions): TextSelectionPointer {
  const [selection, setSelection] = useState<TextSelection | null>(null);
  // The drag's listeners read the latest options, not the ones of the press that started them.
  const latest = useRef(options);
  const stopDrag = useRef<(() => void) | null>(null);

  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => () => stopDrag.current?.(), []);

  return {
    selection,
    startPress(event) {
      const current = latest.current;
      if (!current.enabled || event.button !== 0 || event.pointerType === 'touch') return false;
      const anchor = caretUnderPress(current, event.target, event.clientX, event.clientY);
      if (anchor === null) {
        setSelection(null);
        return false;
      }
      // No native selection or image drag: the model draws the selection.
      event.preventDefault();
      stopDrag.current?.();
      setSelection(new TextSelection(anchor, anchor));
      const move = (moved: PointerEvent) => {
        const focus = caretAtPointer(latest.current, moved.clientX, moved.clientY);
        if (focus !== null) setSelection(new TextSelection(anchor, focus));
      };
      const end = () => stopDrag.current?.();
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

// The caret under a press: only a press on a text span (within the hit tolerance) starts one.
function caretUnderPress(
  current: TextSelectionOptions,
  target: EventTarget | null,
  x: number,
  y: number,
): TextPos | null {
  const span = target instanceof Element ? target.closest('.page-text-line') : null;
  const pageElement = span?.closest<HTMLElement>('[data-page]') ?? null;
  if (pageElement === null) return null;
  const page = Number(pageElement.dataset.page);
  const index = indexOf(current, page);
  if (index === undefined) return null;
  const at = index.hitTest(pagePoint(pageElement, x, y, current.zoom), HIT_TOLERANCE);
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
