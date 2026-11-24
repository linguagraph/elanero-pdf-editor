// Hit testing and the selection of comments for the Select tool (W7.1a slice 6). A port of the
// desktop's annotation_at (ui/view/document_view.py) over the comments.page threads, checked against
// the shared vectors (edit-geometry.json, comment_at) by hitTest.test.ts.
import type { RectDto } from '../rpc/generated';
import type { Point } from '../edit/hitTest';

// Screen pixels a comment is grabbed by beyond its bounds (the desktop's ~3 screen pixels).
export const COMMENT_TOL_PX = 3;

// What a hit test reads from a thread: the comment's tight bounds and whether it is hidden.
export interface HitComment {
  readonly bounds: RectDto;
  readonly hidden: boolean;
}

// The thread under a point: the last visible one whose bounds, grown by tol, contain it. The list is
// read in its own order, so the last thread is the one drawn on top, as the desktop's annotation
// order has it. Hidden comments are never hit.
export function commentAt<T extends { readonly comment: HitComment }>(
  threads: readonly T[],
  point: Point,
  tol: number,
): T | null {
  for (let i = threads.length - 1; i >= 0; i--) {
    const thread = threads[i];
    if (thread === undefined || thread.comment.hidden) continue;
    const b = thread.comment.bounds;
    if (
      point.x >= b.x0 - tol &&
      point.x <= b.x1 + tol &&
      point.y >= b.y0 - tol &&
      point.y <= b.y1 + tol
    ) {
      return thread;
    }
  }
  return null;
}

// One comment the Select tool holds: its page and name, the same reference the engine's
// annotations.* actions take (AnnotRef).
export interface CommentRef {
  readonly page: number;
  readonly name: string;
}

function sameRef(a: CommentRef, b: CommentRef): boolean {
  return a.page === b.page && a.name === b.name;
}

// The selection after a press on a comment. A plain press selects only that comment; Ctrl or Cmd
// toggles it within the selection.
export function nextCommentSelection(
  current: readonly CommentRef[],
  ref: CommentRef,
  additive: boolean,
): readonly CommentRef[] {
  if (!additive) return [ref];
  return current.some((r) => sameRef(r, ref))
    ? current.filter((r) => !sameRef(r, ref))
    : [...current, ref];
}

// The selection without the comments of a page that the page no longer holds (a change to the page
// removed them). Other pages' references are kept.
export function pruneCommentSelection(
  current: readonly CommentRef[],
  page: number,
  names: ReadonlySet<string>,
): readonly CommentRef[] {
  return current.filter((r) => r.page !== page || names.has(r.name));
}
