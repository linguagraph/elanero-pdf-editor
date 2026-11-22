// The Edit tab's image add (W6.7b slice 2a). The user picks a PNG or JPEG first; the file is
// checked here (its first bytes and its size), then the Image tool places a box on the page, and one
// content.add_image adds the picture. The engine checks the file again and is the check that counts
// (actions/content.py `_check_image`). Nothing here decodes the picture.
import type { PageRect } from '../comments/coordinates';
import { downloadBytes } from '../files/downloads';
import { pickFile } from '../files/pickFile';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { ImageDataResult, RunResult } from '../rpc/generated';
import { type CommitDeps, refreshStale } from './commit';
import { offerAddUndo, type ShapeDeps } from './shapes';

// The picker's filter: the two formats the web adds.
export const IMAGE_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';

// The largest file the web adds, in bytes. It mirrors MAX_IMAGE_BYTES in webapi/limits.py (no
// generated type carries it, so the two are kept equal by hand).
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(head: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => head[index] === byte);
}

// True when the first bytes are a PNG or a JPEG signature. Only the head is looked at; the engine
// reads the header properly.
export function isPngOrJpeg(head: Uint8Array): boolean {
  return startsWith(head, PNG_SIGNATURE) || startsWith(head, JPEG_SIGNATURE);
}

// The files the Image tool holds, per tab. A File is a reference to the picked file, not its bytes,
// so holding it costs nothing, and each add reads the bytes anew (a sent buffer is detached).
const pending = new Map<number, File>();

export function setPendingImage(tabId: number, file: File): void {
  pending.set(tabId, file);
}

export function pendingImageOf(tabId: number): File | undefined {
  return pending.get(tabId);
}

export function dropPendingImage(tabId: number): void {
  pending.delete(tabId);
}

// Asks for a file, then checks it: a PNG or JPEG no larger than MAX_IMAGE_BYTES. Returns the file,
// or null when the user cancelled or the file was refused (the refusal is shown here, and the tool
// does not turn on).
export async function chooseImage(store: ToastStore = toasts): Promise<File | null> {
  const file = await pickFile(IMAGE_ACCEPT);
  if (file === null) return null;
  const head = new Uint8Array(await file.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  if (!isPngOrJpeg(head)) {
    store.push('error', t('edit.image.wrongType'));
    return null;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    store.push('error', t('edit.image.tooLarge', { mb: MAX_IMAGE_BYTES / (1024 * 1024) }));
    return null;
  }
  return file;
}

// Adds the picture to the page, fitted inside `rect` at its own proportions, with one actions.run.
// Returns true when the engine made it. A failure is shown and returns false, so the caller keeps
// the tool on, with the same file, and the user can place it again.
export async function addImage(
  deps: ShapeDeps,
  page: number,
  rect: PageRect,
  file: Blob,
): Promise<boolean> {
  const store = deps.store ?? toasts;
  let reply: RunResult;
  try {
    const data = await file.arrayBuffer();
    reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.add_image',
      args: { page, rect, data, keep_proportion: true },
    });
  } catch (error) {
    if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('edit.failed'));
    return false;
  }
  if (!reply.executed) return false;
  deps.cache.clear();
  deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
  offerAddUndo(deps, t('edit.image.added'), reply);
  return true;
}

// The one picture an export names: its page, its key and the page revision the key was listed at.
export interface ImageRef {
  readonly page: number;
  readonly key: string;
  readonly revision: number;
}

// The name an exported picture is saved under: the document's stem, the page and the format. A
// JPEG is saved as .jpg, the usual name.
export function imageFileName(stem: string, page: number, ext: string): string {
  const suffix = ext === 'jpeg' ? 'jpg' : ext;
  return `${stem}-page${page + 1}-image.${suffix}`;
}

// Export Image (W6.7b slice 2b): the picture's own file, downloaded. The document does not change,
// so there is no undo step and no revision moves. A stale ref refreshes the page's list.
export async function exportImage(deps: CommitDeps, ref: ImageRef, stem: string): Promise<boolean> {
  const store = deps.store ?? toasts;
  let reply: ImageDataResult;
  try {
    reply = await deps.rpc.call('content.image', {
      handle: deps.handle,
      page: ref.page,
      key: ref.key,
      revision: ref.revision,
    });
  } catch (error) {
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      await refreshStale(deps, ref.page);
      store.push('warning', t('edit.stale'));
    } else if (error instanceof RpcError && error.code === 'FILE_TOO_LARGE') {
      store.push('error', t('edit.image.exportTooLarge'));
    } else if (error instanceof RpcError) {
      reportRpcError(store, error);
    } else {
      store.push('error', t('edit.failed'));
    }
    return false;
  }
  downloadBytes(imageFileName(stem, ref.page, reply.ext), reply.data, reply.mime);
  return true;
}
