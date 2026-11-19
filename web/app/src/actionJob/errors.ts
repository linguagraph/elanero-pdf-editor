// What an action job's failure shows (W7.4). The refusal for an encrypted document has its own
// message, since the web cannot write an encrypted result back (W1.2 section 13); every other
// failure goes through the RPC error mapping. A cancel is the user's own choice and shows nothing.
import { reportRpcError, type ToastStore } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';

// True for the refusal of a mutating job on an encrypted document (W1.2 section 13).
export function isEncryptedRefusal(error: unknown): boolean {
  return (
    error instanceof RpcError &&
    error.code === 'REFUSED' &&
    error.details['reason'] === 'encrypted_mutating_job'
  );
}

// Shows the failure as a toast. `fallback` is the sentence for a failure that is not an RPC error.
export function reportActionError(store: ToastStore, error: unknown, fallback: MessageId): void {
  if (isEncryptedRefusal(error)) {
    store.push('error', t('job.encryptedRefused'));
    return;
  }
  if (error instanceof RpcError) {
    reportRpcError(store, error);
    return;
  }
  store.push('error', t(fallback));
}
