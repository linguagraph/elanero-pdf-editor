// The scaled scroll space (W5.1a S4, W1.4 section 7). Browsers cap how far an element can scroll
// (Chromium near 33 million CSS px, Firefox at 17.9 million), so a document whose layout is taller
// than SCROLL_SPACE_MAX gets a spacer of that height instead. The scroll position then maps onto the
// layout (the "scene") at a different rate: the spacer's range and the scene's range meet at both
// ends. Below the limit the mapping is the identity, so nothing changes for a normal document.
// Pure arithmetic in CSS pixels; the view does the DOM reads and writes through these functions.

export const SCROLL_SPACE_MAX = 8_000_000;

// Whether a layout of this height needs the scaled space.
export function isScaledSpace(contentHeight: number): boolean {
  return contentHeight > SCROLL_SPACE_MAX;
}

// The height of the scroll spacer: the layout's own height, capped at the limit.
export function spacerHeight(contentHeight: number): number {
  return Math.min(contentHeight, SCROLL_SPACE_MAX);
}

// The scene position at the top of the viewport for a scroll position. The spacer's scroll range
// [0, spacer - viewport] is stretched onto the scene's range [0, content - viewport], so the last
// scroll position shows the bottom of the layout.
export function sceneTopForScroll(
  scrollTop: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  if (!isScaledSpace(contentHeight)) return scrollTop;
  const spacerRange = spacerHeight(contentHeight) - viewportHeight;
  const sceneRange = contentHeight - viewportHeight;
  if (spacerRange <= 0 || sceneRange <= 0) return scrollTop;
  const clamped = Math.min(spacerRange, Math.max(0, scrollTop));
  return (clamped * sceneRange) / spacerRange;
}

// The scroll position that shows a scene position: the inverse of sceneTopForScroll.
export function scrollTopForSceneTop(
  sceneTop: number,
  contentHeight: number,
  viewportHeight: number,
): number {
  if (!isScaledSpace(contentHeight)) return sceneTop;
  const spacerRange = spacerHeight(contentHeight) - viewportHeight;
  const sceneRange = contentHeight - viewportHeight;
  if (spacerRange <= 0 || sceneRange <= 0) return sceneTop;
  const clamped = Math.min(sceneRange, Math.max(0, sceneTop));
  return (clamped * spacerRange) / sceneRange;
}

// Scroll pixels per scene pixel: 1 below the limit. A drag of d pixels moves the scene by d, so the
// scroll moves by d times this (hand pan, W4.10).
export function scrollPerScenePixel(contentHeight: number, viewportHeight: number): number {
  if (!isScaledSpace(contentHeight)) return 1;
  const spacerRange = spacerHeight(contentHeight) - viewportHeight;
  const sceneRange = contentHeight - viewportHeight;
  if (spacerRange <= 0 || sceneRange <= 0) return 1;
  return spacerRange / sceneRange;
}
