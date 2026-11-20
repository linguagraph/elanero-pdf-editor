// Reading and applying the document properties (W7.6). The current values come from session.info,
// an existing call. A change is one actions.run of document.set_metadata, and its info toast
// offers Undo for that step (the shared helper, W4.4b). Nothing here builds the Info block in the engine.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { DocInfo } from '../rpc/generated';
import {
  changedFields,
  type EditableValues,
  editableValues,
  metadataArgs,
  overLongFields,
} from './metadata';

export interface PropertiesDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly store?: ToastStore;
}

// What Apply did. `invalid` means nothing was sent: the caller shows the message.
export type ApplyOutcome =
  | { readonly status: 'unchanged' }
  | { readonly status: 'applied' }
  | { readonly status: 'invalid' }
  | { readonly status: 'failed' };

function reportFailure(store: ToastStore, error: unknown): void {
  if (error instanceof RpcError) reportRpcError(store, error);
  else store.push('error', t('properties.failed'));
}

// The document's properties, read with the existing session.info call. Undefined when the call
// failed; the failure is reported.
export async function loadProperties(deps: PropertiesDeps): Promise<DocInfo | undefined> {
  const store = deps.store ?? toasts;
  try {
    return await deps.rpc.call('session.info', { handle: deps.handle });
  } catch (error) {
    reportFailure(store, error);
    return undefined;
  }
}

// Validates the edited values, then runs document.set_metadata with the changed fields and shows
// the Undo toast. The length check runs before any call.
export async function applyProperties(
  deps: PropertiesDeps,
  info: DocInfo,
  edited: EditableValues,
): Promise<ApplyOutcome> {
  if (overLongFields(edited).length > 0) return { status: 'invalid' };
  const changed = changedFields(editableValues(info), edited);
  if (Object.keys(changed).length === 0) return { status: 'unchanged' };
  const store = deps.store ?? toasts;
  try {
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'document.set_metadata',
      args: { metadata: metadataArgs(info, changed) },
    });
    if (!reply.executed) return { status: 'unchanged' };
    // The Undo offer is for this step only: the engine refuses it once the document has moved on.
    offerUndo('info', t('properties.updated'), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      store,
    });
    return { status: 'applied' };
  } catch (error) {
    reportFailure(store, error);
    return { status: 'failed' };
  }
}
