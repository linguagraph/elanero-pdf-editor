// Committing an Edit tool gesture (W6.7a S5): a move or a resize of the selected objects is one
// content.transform, a delete is one content.delete, each one actions.run and so one undo step on
// the engine. The web keeps no history of its own: the Undo toast undoes the engine's last step.
// The layer previews a gesture; this file is the only place that makes it.
import type { PageRpc } from '../engine/engineConnection';
import { offerUndo } from '../feedback/undoToast';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { PageObjectDto, RectDto, RunResult } from '../rpc/generated';
import type { RenderScheduler } from '../view/renderScheduler';
import type { Affine } from './hitTest';
import { reselect } from './hitTest';
import type { ObjectCache } from './objectCache';

// One committed gesture. Every object is on `page`, at `revision` (the revision its keys were
// listed at). `boxes` are where the objects are after a move or a resize, for the reselection.
export type EditChange =
  | {
      readonly kind: 'move' | 'resize';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
      readonly matrix: Affine;
      readonly boxes: readonly RectDto[];
    }
  | {
      readonly kind: 'delete';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
    }
  | {
      // One picture swapped for the file (W6.7b slice 2b). The engine keeps its box and stretches
      // the new picture to it. The file is read only when the change is sent.
      readonly kind: 'replace';
      readonly page: number;
      readonly revision: number;
      readonly objects: readonly PageObjectDto[];
      readonly file: Blob;
    };

// The selection an edit leaves: the keys of its page at the revision they were listed at.
export interface SettledSelection {
  readonly page: number;
  readonly revision: number;
  readonly keys: readonly string[];
}

export interface CommitDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly cache: ObjectCache;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

const LABELS = {
  move: 'edit.moved',
  resize: 'edit.resized',
  delete: 'edit.deleted',
  replace: 'edit.image.replaced',
} as const;

// Asks the engine for the page's objects again after a stale reply and moves the scheduler to the
// revision it names, so the layer lists the page afresh. A failed ask is left to the next change.
export async function refreshStale(deps: CommitDeps, page: number): Promise<void> {
  deps.cache.clear();
  try {
    const fresh = await deps.rpc.call('content.objects', { handle: deps.handle, page });
    deps.scheduler.noteRevisions({ [String(page)]: fresh.revision });
  } catch {
    // Nothing to do: the next revision change or reopen lists the page again.
  }
}

// The reselection after a move or a resize: the objects now nearest to where they went. Null when
// the list cannot be read, in which case nothing is selected.
async function reselected(
  deps: CommitDeps,
  page: number,
  revision: number,
  boxes: readonly RectDto[],
): Promise<SettledSelection | null> {
  try {
    const list = await deps.cache.get(page, revision);
    if (list.revision !== revision) return null;
    return { page, revision, keys: reselect(list.objects, boxes) };
  } catch {
    return null;
  }
}

// Where the objects of a change are after it, for the reselection. A replace keeps the box it had.
function boxesOf(change: Exclude<EditChange, { kind: 'delete' }>): readonly RectDto[] {
  return change.kind === 'replace' ? change.objects.map((o) => o.bbox) : change.boxes;
}

// The one engine call a change makes. The file of a replace is read here, so an unreadable file
// fails like any other failed edit.
async function runChange(
  deps: CommitDeps,
  change: EditChange,
  refs: readonly { page: number; key: string; revision: number }[],
): Promise<RunResult> {
  if (change.kind === 'replace') {
    const [object] = refs;
    if (object === undefined) throw new Error('a replace names one picture');
    const data = await change.file.arrayBuffer();
    return deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.replace_image',
      args: { object, data },
    });
  }
  if (change.kind === 'delete') {
    return deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.delete',
      args: { objects: refs },
    });
  }
  return deps.rpc.call('actions.run', {
    handle: deps.handle,
    name: 'content.transform',
    args: {
      objects: refs,
      matrix: toMatrix(change.matrix),
      resize: change.kind === 'resize',
    },
  });
}

// Runs the change through the engine, then notes the revisions, offers Undo, and tells the caller
// what to select. `settle` gets null when nothing should stay selected. A BUSY or a refusal keeps
// the selection and shows the usual message.
export async function commitEdit(
  deps: CommitDeps,
  change: EditChange,
  settle: (selection: SettledSelection | null) => void,
): Promise<void> {
  if (change.objects.length === 0) return;
  const store = deps.store ?? toasts;
  const refs = change.objects.map((o) => ({
    page: change.page,
    key: o.key,
    revision: change.revision,
  }));
  let reply: RunResult;
  try {
    reply = await runChange(deps, change, refs);
  } catch (error) {
    if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
      settle(null);
      await refreshStale(deps, change.page);
      store.push('warning', t('edit.stale'));
    } else if (error instanceof RpcError) {
      reportRpcError(store, error);
    } else {
      store.push('error', t('edit.failed'));
    }
    return;
  }
  if (!reply.executed) return;

  const revisions = reply.changed?.revisions ?? {};
  deps.scheduler.noteRevisions(revisions);
  offerUndo('info', t(LABELS[change.kind]), {
    rpc: deps.rpc,
    handle: deps.handle,
    history: reply.state.history,
    onUndone: (undone) => {
      // The engine's history moved back: no list or selection of the old state is kept.
      deps.cache.clear();
      settle(null);
      deps.scheduler.noteRevisions(undone.changed?.revisions ?? {});
    },
    store,
  });

  if (change.kind === 'delete') {
    settle(null);
    return;
  }
  const next = revisions[String(change.page)];
  settle(next === undefined ? null : await reselected(deps, change.page, next, boxesOf(change)));
}

// The six numbers of the matrix as the engine's Matrix dataclass names them.
function toMatrix(m: Affine): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const [a, b, c, d, e, f] = m;
  return { a, b, c, d, e, f };
}
