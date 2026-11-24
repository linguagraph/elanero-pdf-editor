// Moving and resizing comments with the Select tool (W7.1a slice 7). A gesture is one
// annotations.transform: one actions.run, so one undo step on the engine, and an info toast offers
// Undo for it (as the other comment edits). Nothing here builds the change; the engine does (the
// actions layer), and a callout keeps its tip there.
import type { Affine } from '../edit/hitTest';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RenderScheduler } from '../view/renderScheduler';
import type { CommentRef } from './hitTest';

// A move under this many page points on both axes is a click, not a move (the desktop's 0.5 pt,
// select.py: the matrix's e and f).
export const MOVE_MIN_PT = 0.5;

export interface TransformDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

// The matrix that moves by (dx, dy) page points.
export function translation(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy];
}

// Whether a move of (dx, dy) is too small to be a move: both axes under MOVE_MIN_PT.
export function isMoveClick(dx: number, dy: number): boolean {
  return Math.abs(dx) < MOVE_MIN_PT && Math.abs(dy) < MOVE_MIN_PT;
}

// Sends one annotations.transform for the refs and offers Undo for the step. Returns whether the
// engine applied it. A stale reference (the comment was removed) is reported and onStale runs, so
// the caller clears its selection; the engine changes nothing in that case. A non-empty mergeKey
// makes consecutive sends with it one undo step (the presses of a held arrow key, keyboard.ts).
export async function transformComments(
  deps: TransformDeps,
  refs: readonly CommentRef[],
  matrix: Affine,
  resize: boolean,
  onStale: () => void,
  mergeKey = '',
): Promise<boolean> {
  const store = deps.store ?? toasts;
  const [a, b, c, d, e, f] = matrix;
  try {
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.transform',
      args: {
        refs: refs.map((r) => ({ page: r.page, name: r.name })),
        matrix: { a, b, c, d, e, f },
        resize,
        ...(mergeKey === '' ? {} : { merge_key: mergeKey }),
      },
    });
    if (!reply.executed) return false;
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    offerUndo('info', t(resize ? 'comment.resized' : 'comment.moved'), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: (undone) => deps.scheduler.noteRevisions(undone.changed?.revisions ?? {}),
      store,
    });
    return true;
  } catch (error) {
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      store.push('info', t('comments.stale'));
      onStale();
    } else if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('comment.transform.failed'));
    return false;
  }
}
