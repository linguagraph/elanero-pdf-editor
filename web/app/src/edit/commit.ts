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
} as const;

// Asks the engine for the page's objects again after a stale reply and moves the scheduler to the
// revision it names, so the layer lists the page afresh. A failed ask is left to the next change.
async function refreshStale(deps: CommitDeps, page: number): Promise<void> {
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
  change: Extract<EditChange, { kind: 'move' | 'resize' }>,
  revision: number,
): Promise<SettledSelection | null> {
  try {
    const list = await deps.cache.get(change.page, revision);
    if (list.revision !== revision) return null;
    return {
      page: change.page,
      revision,
      keys: reselect(list.objects, change.boxes),
    };
  } catch {
    return null;
  }
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
    reply =
      change.kind === 'delete'
        ? await deps.rpc.call('actions.run', {
            handle: deps.handle,
            name: 'content.delete',
            args: { objects: refs },
          })
        : await deps.rpc.call('actions.run', {
            handle: deps.handle,
            name: 'content.transform',
            args: {
              objects: refs,
              matrix: toMatrix(change.matrix),
              resize: change.kind === 'resize',
            },
          });
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
  settle(next === undefined ? null : await reselected(deps, change, next));
}

// The six numbers of the matrix as the engine's Matrix dataclass names them.
function toMatrix(m: Affine): { a: number; b: number; c: number; d: number; e: number; f: number } {
  const [a, b, c, d, e, f] = m;
  return { a, b, c, d, e, f };
}
