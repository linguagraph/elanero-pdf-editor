// The arithmetic of the Hand tool (W4.10), kept pure so it can be tested without a browser.
// Scroll space here is CSS pixels. A later change to a scaled scroll space (W1.4 section 7, above
// 8 million CSS px) must divide the pointer delta by the scroll factor; nothing does that yet.

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
): { left: number; top: number } {
  const left = start.scrollLeft - (x - start.x);
  const top = start.scrollTop - (y - start.y);
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
