// Placing a comment (W7.1a): one actions.run of annotations.create, then the changed pages are
// drawn again and an info toast offers Undo for that step (the shared helper, W4.4b). Nothing here
// builds a comment; the engine does (the actions layer, W1.3).
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { readPreferences } from '../prefs/store';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RenderScheduler } from '../view/renderScheduler';
import type { PagePoint, PageRect } from './coordinates';
import { chooseAttachment } from './attachFile';
import type { CommentRef } from './hitTest';
import type { CustomStampRef, StandardStamp } from './stamps';
import { STAMP_LABEL } from './stamps';
import type { StampLibrary } from './stampLibrary';
import type { CommentToolId } from './tools';

export interface PlacementDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
  // The custom stamp library, read when a custom stamp is placed (W7.3b S2).
  readonly stamps: Pick<StampLibrary, 'read'>;
}

function reportFailure(store: ToastStore, error: unknown): void {
  if (error instanceof RpcError) reportRpcError(store, error);
  else store.push('error', t('comment.failed'));
}

// The picture of a custom stamp, or 'gone' when the library no longer has it (removed in another
// tab).
async function customImage(
  deps: PlacementDeps,
  id: string,
): Promise<ArrayBuffer | 'gone' | undefined> {
  const blob = await deps.stamps.read(id);
  return blob === undefined ? 'gone' : blob.arrayBuffer();
}

// The comment annotations.create added, from the reply's value: the one AnnotRef the action returns
// (W7.1a). Null for any other value.
export function createdComment(value: unknown): CommentRef | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const [first] = value as readonly unknown[];
  if (typeof first !== 'object' || first === null) return null;
  const { page, name } = first as { page?: unknown; name?: unknown };
  return typeof page === 'number' && typeof name === 'string' ? { page, name } : null;
}

// Attach File (issue 732): asks for the file at the click, then places it as a comment at the click. A
// file the user cancels, or one over the size cap, adds nothing and the tool stays on.
export async function placeAttachment(
  deps: PlacementDeps,
  page: number,
  rect: PageRect,
): Promise<CommentRef | null> {
  const file = await chooseAttachment(deps.store ?? toasts);
  if (file === null) return null;
  return placeComment(deps, 'attach', page, rect, '', [], '', file);
}

// Runs annotations.create for one gesture and shows the Undo toast when a comment was added. It
// resolves to the new comment, or null when nothing was added.
export async function placeComment(
  deps: PlacementDeps,
  tool: CommentToolId,
  page: number,
  rect: PageRect,
  text: string,
  points: readonly PagePoint[] = [],
  stamp: StandardStamp | '' | CustomStampRef = '',
  file: File | null = null,
): Promise<CommentRef | null> {
  const store = deps.store ?? toasts;
  try {
    // A custom stamp is placed by its picture: read it now. A sent buffer is detached, so each
    // placement reads the bytes again.
    const custom = typeof stamp === 'string' ? null : stamp;
    const image = custom === null ? undefined : await customImage(deps, custom.id);
    if (image === 'gone') {
      store.push('error', t('stamp.custom.unreadable'));
      return null;
    }
    // An attachment's bytes are read now, after its size check (chooseAttachment).
    const data = file === null ? undefined : await file.arrayBuffer();
    const name =
      typeof stamp === 'string' ? (stamp === '' ? '' : t(STAMP_LABEL[stamp])) : stamp.label;
    // The author is read at each comment, so a changed name applies to the next one (W4.5 S3).
    const reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'annotations.create',
      args: {
        tool,
        page,
        rect,
        text: custom === null ? text : custom.label,
        points,
        // Only a stamp names one (the engine refuses a stamp without a name). A custom stamp has
        // no name and carries its picture instead.
        ...(tool === 'stamp' ? { stamp: typeof stamp === 'string' ? stamp : '' } : {}),
        ...(image === undefined ? {} : { image }),
        ...(file === null || data === undefined ? {} : { file_name: file.name, file: data }),
        author: readPreferences().authorName,
      },
    });
    if (!reply.executed) return null;
    deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
    const message =
      tool === 'stamp' && name !== ''
        ? t('stamp.placed', { name, page: page + 1 })
        : t('comment.added');
    offerUndo('info', message, {
      rpc: deps.rpc,
      handle: deps.handle,
      history: reply.state.history,
      onUndone: (undone) => deps.scheduler.noteRevisions(undone.changed?.revisions ?? {}),
      store,
    });
    return createdComment(reply.value);
  } catch (error) {
    reportFailure(store, error);
    return null;
  }
}
