// The geometry of the point-list comment tools (W7.1a slice 4): a callout's leader line and
// default box, and the vertex rules the engine applies (src/pdfeditor/actions/comment_tools.py), so
// the preview and the placed comment agree. Pure; the engine still builds and checks each comment.
import type { PagePoint, PageRect } from './coordinates';
import type { CommentToolId } from './tools';

// The leader line's horizontal landing next to the box (model/annotations.py CALLOUT_KNEE).
const CALLOUT_KNEE = 18;
// The default box of a callout drawn as a click (comment_tools DEFAULT_BOX_SIZE, points).
const DEFAULT_BOX_W = 180;
const DEFAULT_BOX_H = 40;
// Vertices closer than this (Manhattan, points) are one (comment_tools REPEAT_TOLERANCE).
const REPEAT_TOLERANCE = 1;
// A click this close to a polygon's first vertex closes it (the desktop's PolyTool: 4 pt).
export const POLYGON_CLOSE_PT = 4;
// A pen stroke samples the pointer at this spacing at most (points); the engine simplifies it.
export const STROKE_STEP_PT = 0.5;
// The most points one comment takes (comment_tools MAX_POINTS).
export const MAX_POINTS = 10_000;

// The callout's leader from its tip to its box, as the desktop's callout_line draws it: to the
// middle of the box side facing the tip, with a short horizontal knee; or to the top or bottom
// middle when the tip is straight above or below the box.
export function calloutLine(tip: PagePoint, box: PageRect): PagePoint[] {
  const midY = (box.y0 + box.y1) / 2;
  const midX = (box.x0 + box.x1) / 2;
  if (tip.x < box.x0 || tip.x > box.x1) {
    const left = tip.x < box.x0;
    const end = { x: left ? box.x0 : box.x1, y: midY };
    const kneeX = left ? end.x - CALLOUT_KNEE : end.x + CALLOUT_KNEE;
    if (tip.x < kneeX === left) return [tip, { x: kneeX, y: midY }, end];
    return [tip, end];
  }
  if (tip.y < box.y0) return [tip, { x: midX, y: box.y0 }];
  if (tip.y > box.y1) return [tip, { x: midX, y: box.y1 }];
  return [tip, { x: box.x0, y: midY }];
}

// The default-size box of a callout drawn as a click at ``at``, on the side away from the tip.
export function defaultCalloutBox(tip: PagePoint, at: PagePoint): PageRect {
  const x0 = at.x >= tip.x ? at.x : at.x - DEFAULT_BOX_W;
  return { x0, y0: at.y - DEFAULT_BOX_H / 2, x1: x0 + DEFAULT_BOX_W, y1: at.y + DEFAULT_BOX_H / 2 };
}

// The smallest box around ``points``; it is the comment's rect (the engine ignores it for these).
export function boundsOf(points: readonly PagePoint[]): PageRect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

export function distance(a: PagePoint, b: PagePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// The points without a repeat of the one before (the engine drops the same ones).
export function distinctVertices(points: readonly PagePoint[]): PagePoint[] {
  const out: PagePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last === undefined || Math.abs(p.x - last.x) + Math.abs(p.y - last.y) > REPEAT_TOLERANCE) {
      out.push(p);
    }
  }
  return out;
}

// The vertices a polygon or polyline is placed with, or null when too few are distinct (a
// polygon needs 3, a polyline 2): the engine would refuse them, so nothing is sent.
export function polyVertices(
  tool: CommentToolId,
  vertices: readonly PagePoint[],
): PagePoint[] | null {
  const distinct = distinctVertices(vertices);
  const minimum = tool === 'polygon' ? 3 : 2;
  return distinct.length >= minimum ? distinct : null;
}

// A pen stroke with one more sampled point, unless it is at the spacing or the limit.
export function appendStrokePoint(stroke: PagePoint[], point: PagePoint): PagePoint[] {
  const last = stroke[stroke.length - 1];
  if (stroke.length >= MAX_POINTS) return stroke;
  if (last !== undefined && distance(last, point) < STROKE_STEP_PT) return stroke;
  return [...stroke, point];
}
