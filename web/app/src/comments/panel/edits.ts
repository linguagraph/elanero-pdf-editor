// Reply, set-status, edit and delete for the Comments panel (W7.1b S4 and S5). A reply and a status
// are one annotations.reply (an AddAnnotationCommand the engine links to the parent by its name);
// an edit is annotations.set_text and a delete is annotations.delete, each one Command with a real
// inverse. The panel does not build the comment; the engine does (the actions layer). A change
// redraws the pages and reads the list again, and an info toast offers Undo for the step.
import type { PageRpc } from '../../engine/engineConnection';
import { offerUndo } from '../../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../../feedback/toasts';
import { t } from '../../i18n/t';
import { readPreferences } from '../../prefs/store';
import { RpcError } from '../../rpc/client';
import type { CommentDto, HistoryResult } from '../../rpc/generated';
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

// Runs one annotations action (a reply, an edit or a delete), then offers Undo for the step.
// Returns whether the engine answered without an error (a skipped change counts as answered).
// A failure is reported as a toast and leaves the document as it was. A stale comment (it was
// changed or removed elsewhere) reads the list again and says so.
async function change(
  deps: EditDeps,
  name: 'annotations.reply' | 'annotations.set_text' | 'annotations.delete',
  args: Record<string, unknown>,
  done: string,
): Promise<boolean> {
  const store = deps.store ?? toasts;
  try {
    const result = await deps.rpc.call('actions.run', { handle: deps.handle, name, args });
    if (!result.executed) {
      deps.controller.noteChange();
      return true;
    }
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
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      deps.controller.noteChange();
      store.push('info', t('comments.stale'));
    } else if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('comments.edit.failed'));
    return false;
  }
}

// Adds a text reply. Blank text is not sent, so the caller need not check it again.
export function replyTo(deps: EditDeps, parent: CommentDto, text: string): Promise<boolean> {
  const body = text.trim();
  if (body === '') return Promise.resolve(false);
  // The author is read at each reply, so a changed name applies to the next one (as placement).
  return change(
    deps,
    'annotations.reply',
    {
      parent: { page: parent.page, name: parent.name },
      text: body,
      author: readPreferences().authorName,
      state: 'None',
    },
    t('comments.reply.added'),
  );
}

// Sets the thread's status: a status-only reply, so the thread's latest state is the new one.
export function setStatus(
  deps: EditDeps,
  parent: CommentDto,
  state: StatusChoice,
): Promise<boolean> {
  return change(
    deps,
    'annotations.reply',
    {
      parent: { page: parent.page, name: parent.name },
      text: '',
      author: readPreferences().authorName,
      state,
    },
    t('comments.status.done'),
  );
}

// Replaces the comment's text (annotations.set_text, one Command). Text that is already there is
// not sent, and counts as done, so the editor closes. A locked comment is refused by the engine,
// and the panel shows that as an error; the Edit button is disabled for a locked comment anyway.
export function editText(deps: EditDeps, comment: CommentDto, text: string): Promise<boolean> {
  if (text === comment.contents) return Promise.resolve(true);
  return change(
    deps,
    'annotations.set_text',
    { ref: { page: comment.page, name: comment.name }, text },
    t('comments.edit.done'),
  );
}

// Deletes the comment and its replies (annotations.delete, one Command, with Undo). A locked
// comment is skipped by the engine, so nothing changes and the list is read again.
export function deleteThread(deps: EditDeps, comment: CommentDto): Promise<boolean> {
  return change(
    deps,
    'annotations.delete',
    { refs: [{ page: comment.page, name: comment.name }] },
    t('comments.delete.done'),
  );
}
