// Runs the Undo and Redo commands (W4.3a S8) through the engine's own history. The engine keeps the
// one undo stack; the web keeps no history of its own. The tab's can-undo and can-redo flags come
// from the engine's state events (tabs/tabState.ts), so the commands' enable state follows it.
import type { PageRpc } from '../engine/engineConnection';
import type { HistoryResult } from '../rpc/generated';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import { reportRpcError, toasts, type ToastStore } from '../feedback/toasts';

export type HistoryDirection = 'undo' | 'redo';

// 'done': a step was undone or redone. 'nothing': the stack had nothing in that direction (a quiet
// no-op; the command is disabled then, so this only happens if the flags were stale). 'failed': the
// engine refused, and the error was reported.
export type HistoryOutcome = 'done' | 'nothing' | 'failed';

export interface HistoryTarget {
  readonly rpc: Pick<PageRpc, 'call'>;
  readonly handle: string;
  // Redraws the changed pages and reloads the lists after a step that went through.
  readonly onDone?: (reply: HistoryResult) => unknown;
  readonly store?: ToastStore;
}

export async function runHistoryStep(
  direction: HistoryDirection,
  target: HistoryTarget,
): Promise<HistoryOutcome> {
  const store = target.store ?? toasts;
  let reply: HistoryResult;
  try {
    // A menu or shortcut Undo takes the newest step, so no expect_history guard is sent (the Undo
    // toast's own guard lives in feedback/undoToast.ts).
    reply =
      direction === 'undo'
        ? await target.rpc.call('actions.undo', { handle: target.handle, expect_history: null })
        : await target.rpc.call('actions.redo', { handle: target.handle });
  } catch (error) {
    if (error instanceof RpcError) {
      reportRpcError(store, error);
    } else {
      store.push('error', t(direction === 'undo' ? 'toast.undo.failed' : 'toast.redo.failed'));
    }
    return 'failed';
  }
  if (!reply.done) return 'nothing';
  await target.onDone?.(reply);
  return 'done';
}
