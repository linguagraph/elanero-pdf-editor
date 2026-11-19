// Placing and undoing a comment (W7.1a): one actions.run of annotations.create, then the changed
// pages are drawn again and an info toast offers Undo, which calls actions.undo. Nothing here
// builds a comment; the engine does (the actions layer, W1.3).
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import { reportRpcError, type ToastStore, toasts, undoAction } from '../feedback/toasts';
import { RpcError } from '../rpc/client';
import type { RenderScheduler } from '../view/renderScheduler';
import type { PageRect } from './coordinates';
import type { CommentToolId } from './tools';

export interface PlacementDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

function reportFailure(store: ToastStore, error: unknown): void {
  if (error instanceof RpcError) reportRpcError(store, error);
  else store.push('error', t('comment.failed'));
}

// Runs annotations.create for one gesture and shows the Undo toast when a comment was added.
export async function placeComment(
  deps: PlacementDeps,
  tool: CommentToolId,
  page: number,
  rect: PageRect,
  text: string,
): Promise<void> {
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.create',
      args: { tool, page, rect, text },
    });
    if (!reply.executed) return;
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    store.push(
      'info',
      t('comment.added'),
      undoAction(() => void undoComment(deps)),
    );
  } catch (error) {
    reportFailure(store, error);
  }
}

// Reverses the last step (the comment just added, when the toast's Undo is pressed).
export async function undoComment(deps: PlacementDeps): Promise<void> {
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('actions.undo', {
      handle: deps.handle,
      expect_history: null,
    });
    if (reply.done) deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
  } catch (error) {
    reportFailure(store, error);
  }
}
