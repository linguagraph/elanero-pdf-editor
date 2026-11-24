// Reading the fonts of the document for the Fonts tab (W7.6). session.fonts walks every page, so
// the dialog calls it only when the tab is first shown. A BUSY reply (a task is running) is not a
// failure to report: the tab offers Retry. Other failures show the shared error toast.
import type { PageRpc } from '../engine/engineConnection';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { FontRow } from '../rpc/generated';

export type FontsState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly fonts: readonly FontRow[] };

export async function loadFonts(
  rpc: PageRpc,
  handle: string,
  store: ToastStore = toasts,
): Promise<FontsState> {
  try {
    const reply = await rpc.call('session.fonts', { handle });
    return { kind: 'ready', fonts: reply.fonts };
  } catch (error) {
    if (error instanceof RpcError && error.code === 'BUSY') return { kind: 'busy' };
    if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('properties.fonts.failed'));
    return { kind: 'failed' };
  }
}
