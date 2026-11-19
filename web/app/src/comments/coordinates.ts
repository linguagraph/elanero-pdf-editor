// The mapping between a pointer position on a page and page points (W1.5 section 6). The page box
// is drawn at zoom x 96/72 CSS pixels per point, so the inverse of the zoom gives points back. Page
// points are visible space with the origin top-left, as the engine expects (Python side, W1.3).
import { CSS_PX_PER_POINT } from '../view/zoom';

export interface PagePoint {
  readonly x: number;
  readonly y: number;
}

// A box in page points, normalized: x0 <= x1 and y0 <= y1.
export interface PageRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

// CSS pixels to page points at a zoom.
export function cssToPoints(pixels: number, zoom: number): number {
  return pixels / (zoom * CSS_PX_PER_POINT);
}

// Page points to CSS pixels at a zoom; the inverse of cssToPoints.
export function pointsToCss(points: number, zoom: number): number {
  return points * zoom * CSS_PX_PER_POINT;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

// The page point under an offset (CSS pixels from the page's top-left corner), kept on the page.
export function pagePointAt(
  offsetX: number,
  offsetY: number,
  zoom: number,
  widthPt: number,
  heightPt: number,
): PagePoint {
  return {
    x: clamp(cssToPoints(offsetX, zoom), 0, widthPt),
    y: clamp(cssToPoints(offsetY, zoom), 0, heightPt),
  };
}

// The normalized box between two page points, e.g. the corners of a drag.
export function rectBetween(a: PagePoint, b: PagePoint): PageRect {
  return {
    x0: Math.min(a.x, b.x),
    y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x),
    y1: Math.max(a.y, b.y),
  };
}

// The points-to-CSS box of a page rect, for drawing a preview at the zoom.
export function cssBox(
  rect: PageRect,
  zoom: number,
): {
  left: number;
  top: number;
  width: number;
  height: number;
} {
  return {
    left: pointsToCss(rect.x0, zoom),
    top: pointsToCss(rect.y0, zoom),
    width: pointsToCss(rect.x1 - rect.x0, zoom),
    height: pointsToCss(rect.y1 - rect.y0, zoom),
  };
}
