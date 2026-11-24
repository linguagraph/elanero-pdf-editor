// The attachment actions of the web panel (W7.9 A2): add a picked file (actions.run), remove one (a
// long action, so it runs as a job, as flatten does; Undo restores its exact entry), and open a PDF
// attachment as a new tab. The engine refuses what it must (a signed document, an empty or
// unusable file); the size check here only spares the read of a file that is certainly too large.
import { type ActionJobWorker, ActionJobCancelled, runActionJob } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import type { JobProgressStore } from '../feedback/jobRun';
import { offerUndo } from '../feedback/undoToast';
import type { ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { AttachmentEntry, HistoryResult, RunResult } from '../rpc/generated';
import { displayName, saveName } from './format';

export const ADD_ACTION = 'attachments.add';
export const REMOVE_ACTION = 'attachments.remove';

// The engine's cap (webapi/limits.py MAX_ATTACHMENT_BYTES, 100 MiB). The engine refuses a larger
// file too; this copy only saves reading a file it will refuse.
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_MB = MAX_ATTACHMENT_BYTES / (1024 * 1024);

// A PDF is recognised by its "%PDF-" marker in the first kilobyte (the spec allows junk before it),
// not by the file's name, which the attachment may not match.
const PDF_HEAD_BYTES = 1024;
const PDF_MARK = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function isPdfBytes(bytes: ArrayBuffer): boolean {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PDF_HEAD_BYTES));
  for (let start = 0; start + PDF_MARK.length <= head.length; start += 1) {
    if (PDF_MARK.every((byte, offset) => head[start + offset] === byte)) return true;
  }
  return false;
}

export interface AttachmentDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly store: ToastStore;
  // The app's Undo handler: an Undo toast's step reloads what the app shows.
  readonly onHistoryStep: (reply: HistoryResult) => void;
  // The job worker and progress store for the remove job (App's jobs.acquire).
  readonly startWorker: () => ActionJobWorker;
  readonly progress?: JobProgressStore;
}

// Adds the picked file as a new attachment, with an Undo toast. Resolves with the name the engine
// embedded it under (a free one when the name was taken), or null when nothing was added (the
// failure is shown).
export async function addFile(deps: AttachmentDeps, file: File): Promise<string | null> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    deps.store.push('error', t('attachments.tooLarge', { mb: MAX_ATTACHMENT_MB }));
    return null;
  }
  let reply: RunResult;
  try {
    const data = await file.arrayBuffer();
    reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: ADD_ACTION,
      args: { data, filename: file.name, description: '' },
    });
  } catch (error) {
    reportActionError(deps.store, error, 'attachments.addFailed');
    return null;
  }
  if (!reply.executed || typeof reply.value !== 'string') return null;
  const name = reply.value;
  offerUndo('info', t('attachments.added', { name }), {
    rpc: deps.rpc,
    handle: deps.handle,
    history: reply.state.history,
    onUndone: deps.onHistoryStep,
    store: deps.store,
  });
  return name;
}

// Removes one attachment as an undoable job, with an Undo toast. Resolves true when it was removed;
// false when the user cancelled the job (nothing is shown) or it failed (the failure is shown).
export async function removeAttachment(
  deps: AttachmentDeps,
  entry: AttachmentEntry,
): Promise<boolean> {
  try {
    const outcome = await runActionJob(
      { engine: deps.rpc, startWorker: deps.startWorker, progress: deps.progress },
      deps.handle,
      REMOVE_ACTION,
      { name: entry.name },
    );
    offerUndo('info', t('attachments.removed', { name: displayName(entry) }), {
      rpc: deps.rpc,
      handle: deps.handle,
      history: outcome.history,
      onUndone: deps.onHistoryStep,
      store: deps.store,
    });
    return true;
  } catch (error) {
    if (error instanceof ActionJobCancelled) return false;
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      deps.store.push('info', t('attachments.stale'));
      return false;
    }
    reportActionError(deps.store, error, 'attachments.removeFailed');
    return false;
  }
}

// Whether the attachment's bytes are a PDF. Reads the bytes (attachments.get), so it is called once
// per selection; a failed read answers false, and the panel then offers no Open for it.
export async function probePdf(rpc: PageRpc, handle: string, name: string): Promise<boolean> {
  try {
    const file = await rpc.call('attachments.get', { handle, name });
    return isPdfBytes(file.data);
  } catch {
    return false;
  }
}

// Opens a PDF attachment as a new tab, through the normal open path (password, limits and the engine
// worker). The bytes become a File named as the browser would save it, so nothing else changes.
export async function openPdfAttachment(
  deps: Pick<AttachmentDeps, 'rpc' | 'handle' | 'store'>,
  entry: AttachmentEntry,
  openFiles: (files: readonly File[]) => void,
): Promise<void> {
  try {
    const file = await deps.rpc.call('attachments.get', { handle: deps.handle, name: entry.name });
    if (!isPdfBytes(file.data)) {
      deps.store.push('error', t('attachments.openFailed'));
      return;
    }
    openFiles([new File([file.data], saveName(file.filename), { type: 'application/pdf' })]);
  } catch (error) {
    reportActionError(deps.store, error, 'attachments.openFailed');
  }
}
