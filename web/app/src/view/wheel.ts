// Ctrl+wheel zoom (W1.4 sections 3 and 4). Pure helpers: the event is read by the caller, so the
// arithmetic can be tested without a browser. A zoom keeps the document point under the pointer at
// the same place on screen, as the desktop's zoom_at does.

// Ctrl on Windows and Linux, Cmd (Meta) on macOS: the modifier a browser would use to zoom the page.
export function isZoomWheel(event: {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}): boolean {
  return event.ctrlKey || event.metaKey;
}

// A wheel delta in CSS pixels. Firefox can report lines (deltaMode 1) and pages (2); a line is taken
// as 16 px, a page as 800 px.
export function wheelDeltaPixels(event: {
  readonly deltaY: number;
  readonly deltaMode: number;
}): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * 800;
  return event.deltaY;
}

// The vertical scroll a key moves a scroll container by, in CSS pixels: an arrow moves one line, as
// the browsers do, and the page keys (PageUp, PageDown, Space, Shift+Space) move seven eighths of the
// viewport. Null for any other key, which the browser handles.
export const KEY_LINE_PX = 40;
const KEY_PAGE_FRACTION = 7 / 8;

export function keyScrollPixels(
  key: string,
  shiftKey: boolean,
  viewportHeight: number,
): number | null {
  const page = viewportHeight * KEY_PAGE_FRACTION;
  if (key === 'ArrowDown') return KEY_LINE_PX;
  if (key === 'ArrowUp') return -KEY_LINE_PX;
  if (key === 'PageDown' || (key === ' ' && !shiftKey)) return page;
  if (key === 'PageUp' || (key === ' ' && shiftKey)) return -page;
  return null;
}

// A trackpad pinch sends many small deltas, so one zoom step is taken per this many pixels.
export const WHEEL_STEP_PX = 40;

// Adds a delta to the pending amount. When the total reaches a step, returns the direction (+1 zoom
// in for a wheel up, -1 zoom out) and clears the pending amount; otherwise direction is null.
export function takeWheelSteps(
  pending: number,
  deltaY: number,
): { direction: 1 | -1 | null; pending: number } {
  const total = pending + deltaY;
  if (total <= -WHEEL_STEP_PX) return { direction: 1, pending: 0 };
  if (total >= WHEEL_STEP_PX) return { direction: -1, pending: 0 };
  return { direction: null, pending: total };
}

export interface AnchorInput {
  // The scroll container's current scroll position, in CSS pixels.
  readonly scrollLeft: number;
  readonly scrollTop: number;
  // The pointer, relative to the scroll container's top-left corner (not the scroll content).
  readonly pointerX: number;
  readonly pointerY: number;
  readonly fromZoom: number;
  readonly toZoom: number;
}

// The scroll position that keeps the content point under the pointer where it was. Every page box
// scales linearly with zoom and the content starts at the origin, so a point at content x moves to
// x * toZoom / fromZoom. Browsers clamp the result to the scrollable range.
export function anchoredScroll(input: AnchorInput): { left: number; top: number } {
  const ratio = input.toZoom / input.fromZoom;
  const contentX = input.scrollLeft + input.pointerX;
  const contentY = input.scrollTop + input.pointerY;
  return {
    left: Math.max(0, contentX * ratio - input.pointerX),
    top: Math.max(0, contentY * ratio - input.pointerY),
  };
}
