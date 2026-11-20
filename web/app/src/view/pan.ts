// The arithmetic of the Hand tool (W4.10), kept pure so it can be tested without a browser.
// Scroll space here is CSS pixels. Above the scaled-space limit (scrollSpace.ts) one pixel of drag
// moves the scene by one pixel, which is `ratio` scroll pixels, so the caller passes that ratio.

export interface PanStart {
  readonly scrollLeft: number;
  readonly scrollTop: number;
  // The pointer position (client coordinates) when the drag began.
  readonly x: number;
  readonly y: number;
}

export interface ScrollLimits {
  // scrollWidth - clientWidth, and scrollHeight - clientHeight.
  readonly maxLeft: number;
  readonly maxTop: number;
}

// The scroll position for a pointer at (x, y): the content follows the pointer, so the scroll moves
// the opposite way to the pointer's delta. The result is kept inside [0, max].
export function panTo(
  start: PanStart,
  x: number,
  y: number,
  limits: ScrollLimits,
  ratio = 1,
): { left: number; top: number } {
  const left = start.scrollLeft - (x - start.x);
  const top = start.scrollTop - (y - start.y) * ratio;
  return {
    left: clamp(left, 0, Math.max(0, limits.maxLeft)),
    top: clamp(top, 0, Math.max(0, limits.maxTop)),
  };
}

// Whether a point (client coordinates) falls on the element's scrollbar rather than its content.
// The scrollbars sit at the right and at the bottom, outside the client area.
export function onScrollbar(
  rect: DOMRect,
  clientWidth: number,
  clientHeight: number,
  x: number,
  y: number,
): boolean {
  return x >= rect.left + clientWidth || y >= rect.top + clientHeight;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
