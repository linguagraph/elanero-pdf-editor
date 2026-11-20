// Placing a comment (W7.1a): one actions.run of annotations.create, then the changed pages are
// drawn again and an info toast offers Undo for that step (the shared helper, W4.4b). Nothing here
// builds a comment; the engine does (the actions layer, W1.3).
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { readPreferences } from '../prefs/store';
import { t } from '../i18n/t';
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
    // The author is read at each comment, so a changed name applies to the next one (W4.5 S3).
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.create',
      args: { tool, page, rect, text, author: readPreferences().authorName },
    });
    if (!reply.executed) return;
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    offerUndo('info', t('comment.added'), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: (undone) => deps.scheduler.noteRevisions(undone.changed?.revisions ?? {}),
      store,
    });
  } catch (error) {
    reportFailure(store, error);
  }
}
