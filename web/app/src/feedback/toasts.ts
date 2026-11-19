// The toast queue (W1.6 section 10, W4.4b). Info and success toasts time out; errors stay until the
// user dismisses them, because an error the user has not read is the one they most need. At most
// VISIBLE_TOASTS show at once; the rest wait in order and move up as room frees. The queue logic is
// pure, so it is tested without a DOM, and the store is the only shared state.
import { useSyncExternalStore } from 'react';
import { mapRpcError } from '../rpc/errors';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';

// A warning is something that may cost the user work (the copy that could not be kept), shown in the
// warning colour. It times out like info; only an error stays until dismissed.
export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  // Already translated: the caller passes text from t(), so this file holds no English.
  readonly text: string;
  // An optional button after the text. Only the caller that can really undo a change passes one.
  readonly action?: ToastAction;
}

// A button on a toast. The label is already translated. Running the action closes the toast.
export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

// The Undo action for a toast about a change the caller can reverse (W1.6 section 10).
export function undoAction(run: () => void): ToastAction {
  return { label: t('toast.undo'), run };
}

export interface ToastQueue {
  readonly visible: readonly Toast[];
  readonly queued: readonly Toast[];
}

export const VISIBLE_TOASTS = 3;
export const AUTO_DISMISS_MS = 5000;

export function timesOut(kind: ToastKind): boolean {
  return kind !== 'error';
}

export const EMPTY_QUEUE: ToastQueue = { visible: [], queued: [] };

export function enqueueToast(queue: ToastQueue, toast: Toast, limit = VISIBLE_TOASTS): ToastQueue {
  if (queue.visible.length < limit) {
    return { visible: [...queue.visible, toast], queued: queue.queued };
  }
  return { visible: queue.visible, queued: [...queue.queued, toast] };
}

// Removes a toast from either list, then moves the oldest waiting toasts up into free places.
export function removeToast(queue: ToastQueue, id: number, limit = VISIBLE_TOASTS): ToastQueue {
  const visible = queue.visible.filter((toast) => toast.id !== id);
  const queued = queue.queued.filter((toast) => toast.id !== id);
  const room = Math.max(0, limit - visible.length);
  return {
    visible: [...visible, ...queued.slice(0, room)],
    queued: queued.slice(room),
  };
}

export interface ToastStore {
  getState(): ToastQueue;
  subscribe(listener: () => void): () => void;
  push(kind: ToastKind, text: string, action?: ToastAction): number;
  dismiss(id: number): void;
}

export function createToastStore(): ToastStore {
  let state: ToastQueue = EMPTY_QUEUE;
  let nextId = 1;
  const listeners = new Set<() => void>();

  const update = (next: ToastQueue): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(kind, text, action) {
      const id = nextId++;
      const toast: Toast = action === undefined ? { id, kind, text } : { id, kind, text, action };
      update(enqueueToast(state, toast));
      return id;
    },
    dismiss(id) {
      update(removeToast(state, id));
    },
  };
}

// The app's toast store. Components read it through useToasts; features push into it.
export const toasts: ToastStore = createToastStore();

export function useToasts(store: ToastStore = toasts): ToastQueue {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// Shows a failed RPC call as an error toast, worded through the catalogue (W4.7). A failure the
// user asked for (a cancel) shows nothing, as the mapping says.
export function reportRpcError(store: ToastStore, error: RpcError): number | undefined {
  const presentation = mapRpcError(error);
  if (presentation.silent) return undefined;
  return store.push('error', t(presentation.messageId, presentation.params));
}
