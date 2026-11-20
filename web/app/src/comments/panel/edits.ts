// Reply and set-status for the Comments panel (W7.1b S4). Both are one annotations.reply: an
// AddAnnotationCommand that the engine links to the parent by its name, so it is one undo step and
// survives a save. The panel does not build the comment; the engine does (the actions layer). A
// change redraws the pages and reads the list again, and an info toast offers Undo for the step.
import type { PageRpc } from '../../engine/engineConnection';
import { offerUndo } from '../../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../../feedback/toasts';
import { t } from '../../i18n/t';
import { readPreferences } from '../../prefs/store';
import { RpcError } from '../../rpc/client';
import type { CommentDto, HistoryResult, ReviewState } from '../../rpc/generated';
import type { RenderScheduler } from '../../view/renderScheduler';

// The states the panel offers. "None" is not one of them: a status is set, not cleared (the
// desktop's Set Status menu offers the same four).
export const STATUS_CHOICES = ['Accepted', 'Rejected', 'Cancelled', 'Completed'] as const;
export type StatusChoice = (typeof STATUS_CHOICES)[number];

export interface EditDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  // The list's controller: a change reads the list again (debounced while the panel is open).
  readonly controller: { readonly noteChange: () => void };
  readonly store?: ToastStore;
}

// Runs annotations.reply on `parent`, then offers Undo for the step. Returns whether a reply was
// added. A failure is reported as a toast and leaves the document as it was.
async function reply(
  deps: EditDeps,
  parent: CommentDto,
  text: string,
  state: ReviewState,
  done: string,
): Promise<boolean> {
  const store = deps.store ?? toasts;
  try {
    // The author is read at each reply, so a changed name applies to the next one (as placement).
    const result = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.reply',
      args: {
        parent: { page: parent.page, name: parent.name },
        text,
        author: readPreferences().authorName,
        state,
      },
    });
    if (!result.executed) return false;
    deps.scheduler.noteRevisions(result.changed?.revisions ?? {});
    deps.controller.noteChange();
    const refresh = (undone: HistoryResult) => {
      deps.scheduler.noteRevisions(undone.changed?.revisions ?? {});
      deps.controller.noteChange();
    };
    offerUndo('info', done, {
      rpc: deps.rpc,
      handle: deps.handle,
      history: result.state.history,
      onUndone: refresh,
      store,
    });
    return true;
  } catch (error) {
    if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('comments.edit.failed'));
    return false;
  }
}

// Adds a text reply. Blank text is not sent, so the caller need not check it again.
export function replyTo(deps: EditDeps, parent: CommentDto, text: string): Promise<boolean> {
  const body = text.trim();
  if (body === '') return Promise.resolve(false);
  return reply(deps, parent, body, 'None', t('comments.reply.added'));
}

// Sets the thread's status: a status-only reply, so the thread's latest state is the new one.
export function setStatus(
  deps: EditDeps,
  parent: CommentDto,
  state: StatusChoice,
): Promise<boolean> {
  return reply(deps, parent, '', state, t('comments.status.done'));
}
