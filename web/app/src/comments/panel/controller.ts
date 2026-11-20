// The comments list of one open document (W7.1b S2): the threads from comments.list, the filter,
// and whether the panel is open. One controller per document, so a tab keeps its own filter and
// list. The list is read from the engine (read-only, no Command), so the engine stays the one
// source. Changes reload it, debounced, but only while the panel is open: a closed panel marks the
// list stale and reads it on open. The view reads it through subscribe/getSnapshot, with no React.
import type { PageRpc } from '../../engine/engineConnection';
import type { CommentThreadDto } from '../../rpc/generated';
import type { RenderScheduler } from '../../view/renderScheduler';
import {
  type CommentFilter,
  type FilterOptions,
  filterOptions,
  NO_FILTER,
  visibleThreads,
} from './filters';

// Quiet time before a burst of changes is read again, so a run of edits costs one read.
const DEBOUNCE_MS = 150;

export interface CommentsDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'subscribeRevisions'>;
  readonly debounceMs?: number;
}

export interface CommentsSnapshot {
  // The whole list, in the engine's order (replies oldest first).
  readonly threads: readonly CommentThreadDto[];
  // The threads that pass the filter.
  readonly visible: readonly CommentThreadDto[];
  readonly options: FilterOptions;
  readonly filter: CommentFilter;
  // The engine stopped at its entry cap, so some threads are not in the list.
  readonly truncated: boolean;
  // The first read has come back, so an empty list means the document has no comments.
  readonly loaded: boolean;
  readonly open: boolean;
}

function snapshotOf(
  threads: readonly CommentThreadDto[],
  filter: CommentFilter,
  rest: Pick<CommentsSnapshot, 'truncated' | 'loaded' | 'open'>,
): CommentsSnapshot {
  return {
    threads,
    visible: visibleThreads(threads, filter),
    options: filterOptions(threads, filter),
    filter,
    ...rest,
  };
}

export class CommentsController {
  private snapshot: CommentsSnapshot = snapshotOf([], NO_FILTER, {
    truncated: false,
    loaded: false,
    open: false,
  });
  private readonly listeners = new Set<() => void>();
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // A change arrived while the panel was closed: the next open reads the list.
  private stale = false;
  // Each read gets a number. A reply older than the one applied is dropped, so a slow read never
  // overwrites a newer list.
  private issued = 0;
  private applied = 0;

  constructor(private readonly deps: CommentsDeps) {
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  }

  readonly getSnapshot = (): CommentsSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(
    next: Partial<Pick<CommentsSnapshot, 'threads' | 'truncated' | 'loaded' | 'open' | 'filter'>>,
  ): void {
    const current = this.snapshot;
    this.snapshot = snapshotOf(next.threads ?? current.threads, next.filter ?? current.filter, {
      truncated: next.truncated ?? current.truncated,
      loaded: next.loaded ?? current.loaded,
      open: next.open ?? current.open,
    });
    for (const listener of this.listeners) listener();
  }

  // Keeps the list in step with the document. A page's revision moving (any annotation or structure
  // change, an undo's included) is a change; undo, redo and save call noteChange themselves, since
  // save renames the synthetic #n comment names. Returns the stop, which also drops a pending read.
  start(): () => void {
    const stopRevisions = this.deps.scheduler.subscribeRevisions(() => this.noteChange());
    return () => {
      stopRevisions();
      this.cancelTimer();
    };
  }

  // The panel opens or closes. Opening reads the list when it is stale or was never read.
  setOpen(open: boolean): void {
    if (this.snapshot.open === open) return;
    this.update({ open });
    if (open && (this.stale || !this.snapshot.loaded)) void this.reload();
  }

  // A change to the document. While the panel is open the list is read again after a quiet
  // moment; while it is closed the list is only marked stale.
  noteChange(): void {
    if (!this.snapshot.open) {
      this.stale = true;
      return;
    }
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reload();
    }, this.debounceMs);
  }

  // Reads the list now. A failed read keeps what the list had: a closed document is the usual
  // cause, and the next change reads again.
  async reload(): Promise<void> {
    this.cancelTimer();
    this.stale = false;
    const seq = ++this.issued;
    try {
      const reply = await this.deps.rpc.call('comments.list', { handle: this.deps.handle });
      if (seq < this.applied) return;
      this.applied = seq;
      this.update({ threads: reply.threads, truncated: reply.truncated, loaded: true });
    } catch {
      this.stale = true;
    }
  }

  // Sets the filter fields a patch names. The other fields keep their value.
  setFilter(patch: Partial<CommentFilter>): void {
    this.update({ filter: { ...this.snapshot.filter, ...patch } });
  }

  clearFilter(): void {
    this.update({ filter: NO_FILTER });
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
