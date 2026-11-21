// Runs one bookmark edit through the engine's actions (W5.2 S2): actions.run, then an Undo toast for
// the step it made, or the message for a failure. The panel reloads the outline itself, from the
// outcome it gets back; this file only talks to the engine and the toasts.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, toasts, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { HistoryResult } from '../rpc/generated';
import { RpcError } from '../rpc/client';

export interface BookmarkEditDeps {
  readonly rpc: Pick<PageRpc, 'call'>;
  readonly handle: string;
  // The app's Undo handler: a step that changed the outline remounts or reloads the lists.
  readonly onHistoryStep: (reply: HistoryResult) => void;
  readonly store?: ToastStore;
}

// 'done': the edit went through (an Undo toast was shown). 'unchanged': the engine found nothing to
// do. 'stale': the outline had changed, so nothing was edited. 'failed': an error was reported.
export type BookmarkEditOutcome = 'done' | 'unchanged' | 'stale' | 'failed';

export interface BookmarkEditResult {
  readonly outcome: BookmarkEditOutcome;
  // The action's own value when it went through (an add's new flat index), else undefined.
  readonly value?: unknown;
}

export async function runBookmarkEdit(
  deps: BookmarkEditDeps,
  name: string,
  args: Record<string, unknown>,
  text: string,
): Promise<BookmarkEditResult> {
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('actions.run', { handle: deps.handle, name, args });
    if (!reply.executed) return { outcome: 'unchanged' };
    offerUndo('info', text, {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: deps.onHistoryStep,
      store,
    });
    return { outcome: 'done', value: reply.value };
  } catch (error) {
    if (error instanceof RpcError) {
      if (error.code === 'STALE_OBJECT') {
        store.push('info', t('bookmarks.stale'));
        return { outcome: 'stale' };
      }
      reportRpcError(store, error);
      return { outcome: 'failed' };
    }
    store.push('error', t('bookmarks.editFailed'));
    return { outcome: 'failed' };
  }
}
