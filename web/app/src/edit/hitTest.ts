// Hit testing and resize geometry for the Edit tool (W6.7a S3). A port of the Qt-free
// pdfeditor.actions.edit_geometry module, so the browser picks the same object, puts the same
// handles and reshapes a box the same way as the desktop. The shared vectors in
// web/src/tools/vectors/edit-geometry.json pin both sides to the same answers.
import type { RectDto } from '../rpc/generated';

export interface Point {
  x: number;
  y: number;
}

// The minimal shape a hit test needs: an object's key and its outline in page points.
export interface Hittable {
  key: string;
  bbox: RectDto;
}

// The six numbers of a PDF affine matrix, [a, b, c, d, e, f].
export type Affine = readonly [number, number, number, number, number, number];

// Screen pixels a handle grabs; callers divide by the zoom to get a tolerance in page points.
export const HANDLE_PX = 6;
// Screen pixels an object is grabbed by beyond its outline.
export const OBJECT_TOL_PX = 2;
// A drag this short on both axes is a click, not a move or a rubber band.
export const MIN_DRAG = 3;
// The smallest side a resize may leave, in the box's own units (4 scene pixels on the desktop).
export const MIN_SIZE = 4;

// Where each handle sits, as (column, row) with 0 = low edge, 1 = middle, 2 = high edge. The order
// is the handle index used everywhere: left to right along the top, then the middle row, then the
// bottom row.
const HANDLE_CELLS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [2, 0],
  [0, 1],
  [2, 1],
  [0, 2],
  [1, 2],
  [2, 2],
];

// The eight handle positions on a box, in handle-index order.
export function handlePoints(box: RectDto): Point[] {
  const xs = [box.x0, (box.x0 + box.x1) / 2, box.x1];
  const ys = [box.y0, (box.y0 + box.y1) / 2, box.y1];
  return HANDLE_CELLS.map(([col, row]) => ({ x: xs[col] ?? box.x0, y: ys[row] ?? box.y0 }));
}

// The index of the first handle within tol of the point on both axes, or null.
export function handleAt(box: RectDto, point: Point, tol: number): number | null {
  const found = handlePoints(box).findIndex(
    (h) => Math.abs(h.x - point.x) <= tol && Math.abs(h.y - point.y) <= tol,
  );
  return found === -1 ? null : found;
}

// The box with the edges that the handle controls moved to the point. The edges stop minSize short
// of the opposite edge, so a drag past it pins the box at that size instead of inverting it.
export function resizeBox(
  box: RectDto,
  handle: number,
  point: Point,
  minSize: number = MIN_SIZE,
): RectDto {
  const [col, row] = HANDLE_CELLS[handle] ?? [1, 1];
  let { x0, y0, x1, y1 } = box;
  if (col === 0) x0 = Math.min(point.x, x1 - minSize);
  else if (col === 2) x1 = Math.max(point.x, x0 + minSize);
  if (row === 0) y0 = Math.min(point.y, y1 - minSize);
  else if (row === 2) y1 = Math.max(point.y, y0 + minSize);
  return { x0, y0, x1, y1 };
}

// Whether a press at a released at b stays within minDrag on both axes.
export function isClick(a: Point, b: Point, minDrag: number = MIN_DRAG): boolean {
  return Math.abs(b.x - a.x) <= minDrag && Math.abs(b.y - a.y) <= minDrag;
}

// The smallest object whose outline, grown by tol, contains the point. The smallest wins, so an
// image inside a large text block is the one picked. Ties keep the first object in the list.
export function objectAt<T extends Hittable>(
  objects: readonly T[],
  point: Point,
  tol: number,
): T | null {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const o of objects) {
    const b = o.bbox;
    const inside =
      b.x0 - tol <= point.x &&
      point.x <= b.x1 + tol &&
      b.y0 - tol <= point.y &&
      point.y <= b.y1 + tol;
    if (!inside) continue;
    const area = (b.x1 - b.x0) * (b.y1 - b.y0);
    if (area < bestArea) {
      best = o;
      bestArea = area;
    }
  }
  return best;
}

// The objects whose outline meets the box. Touching edges do not count, as on the desktop.
export function objectsIn<T extends Hittable>(objects: readonly T[], box: RectDto): T[] {
  return objects.filter((o) => {
    const b = o.bbox;
    return !(box.x0 >= b.x1 || box.x1 <= b.x0 || box.y0 >= b.y1 || box.y1 <= b.y0);
  });
}

// The matrix that maps old onto new by scaling about old's origin. A zero-width or zero-height old
// box keeps its scale at 1 on that axis, so the result stays finite.
export function fitMatrix(old: RectDto, next: RectDto): Affine {
  const ow = old.x1 - old.x0;
  const oh = old.y1 - old.y0;
  const sx = ow ? (next.x1 - next.x0) / ow : 1;
  const sy = oh ? (next.y1 - next.y0) / oh : 1;
  return [sx, 0, 0, sy, next.x0 - old.x0 * sx, next.y0 - old.y0 * sy];
}

// For each moved box, the key of the object whose top-left corner is nearest to it (Manhattan
// distance). Boxes with no candidate are skipped. Keys can repeat if two boxes share one.
export function reselect(objects: readonly Hittable[], boxes: readonly RectDto[]): string[] {
  const chosen: string[] = [];
  for (const box of boxes) {
    let best: Hittable | null = null;
    let bestDist = Infinity;
    for (const o of objects) {
      const dist = Math.abs(o.bbox.x0 - box.x0) + Math.abs(o.bbox.y0 - box.y0);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    if (best !== null) chosen.push(best.key);
  }
  return chosen;
}
