// The Undo toast for a step the user just took (W4.4b). Every feature that offers Undo goes
// through here, so the stale and error policy is in one place: the engine refuses an undo when the
// history moved since the offer (`expect_history`), and this file turns that refusal into a quiet
// notice. The toast's button never moves focus; the outcome is a new toast.
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { HistoryResult } from '../rpc/generated';
import { RpcError } from '../rpc/client';
import { reportRpcError, toasts, undoAction, type ToastKind, type ToastStore } from './toasts';

export interface UndoOffer {
  readonly rpc: Pick<PageRpc, 'call'>;
  readonly handle: string;
  // reply.state.history of the step the toast offers.
  readonly history: number;
  // Redraws and reloads lists after an undo that went through.
  readonly onUndone?: (reply: HistoryResult) => unknown;
  readonly store?: ToastStore;
}

export type UndoOutcome = 'undone' | 'stale' | 'failed';

// Pushes a toast whose Undo button undoes the step `offer` describes. Returns the toast id.
export function offerUndo(kind: ToastKind, text: string, offer: UndoOffer): number {
  const store = offer.store ?? toasts;
  return store.push(
    kind,
    text,
    undoAction(() => void undoOffered(offer)),
  );
}

// Runs the undo of an offered step. Only the offered step is undone: if the document changed since
// the offer, the engine refuses and nothing is undone.
export async function undoOffered(offer: UndoOffer): Promise<UndoOutcome> {
  const store = offer.store ?? toasts;
  let reply: HistoryResult;
  try {
    reply = await offer.rpc.call('actions.undo', {
      handle: offer.handle,
      expect_history: offer.history,
    });
  } catch (error) {
    if (error instanceof RpcError) {
      // A restarted engine gives the document a new handle (NO_DOCUMENT): that is the same quiet
      // "changed since" outcome, not a reason to tell the user to close the document.
      if (error.code === 'STALE_OBJECT' || error.code === 'NO_DOCUMENT') {
        store.push('info', t('toast.undo.stale'));
        return 'stale';
      }
      reportRpcError(store, error);
      return 'failed';
    }
    store.push('error', t('toast.undo.failed'));
    return 'failed';
  }
  if (!reply.done) {
    // Cannot happen with expect_history (an empty stack is refused); treated as stale defensively.
    store.push('info', t('toast.undo.stale'));
    return 'stale';
  }
  await offer.onUndone?.(reply);
  return 'undone';
}
