// The redaction state of one open document (W7.4): whether the mark tool is on, the marks made and
// not yet applied, and the apply while it runs. The view reads it through subscribe/getSnapshot, so
// it has no React in it and the tests can drive it directly. Every change to the document goes
// through the calls in redaction.ts, which are Commands on the engine side.
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRect } from '../comments/coordinates';
import type { PageRpc } from '../engine/engineConnection';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import { toasts, type ToastStore, undoAction } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { RenderScheduler } from '../view/renderScheduler';
import type { MarkRef } from './marks';
import { addRedactionMark, applyRedactions, removeRedactionMarks, undoLastStep } from './redaction';

export interface RedactionDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly startWorker: () => ActionJobWorker;
  readonly store?: ToastStore;
  readonly progress?: JobProgressStore;
}

export interface RedactionSnapshot {
  // The mark tool is on: a drag on a page marks an area.
  readonly active: boolean;
  // The marks made and not applied yet, in the order they were made.
  readonly marks: readonly MarkRef[];
  // An apply is running.
  readonly busy: boolean;
}

export class RedactionController {
  private snapshot: RedactionSnapshot = { active: false, marks: [], busy: false };
  private readonly listeners = new Set<() => void>();
  private readonly store: ToastStore;
  private readonly progress: JobProgressStore;

  constructor(private readonly deps: RedactionDeps) {
    this.store = deps.store ?? toasts;
    this.progress = deps.progress ?? jobProgress;
  }

  readonly getSnapshot = (): RedactionSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(next: Partial<RedactionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  setActive(active: boolean): void {
    if (this.snapshot.active !== active) this.update({ active });
  }

  // Marks one box drawn on a page. Refused while an apply runs, since the document is read-only.
  async add(page: number, rect: PageRect): Promise<void> {
    if (this.snapshot.busy) return;
    try {
      const { marks, changed } = await addRedactionMark(
        this.deps.rpc,
        this.deps.handle,
        page,
        rect,
      );
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
      if (marks.length > 0) this.update({ marks: [...this.snapshot.marks, ...marks] });
    } catch (error) {
      reportActionError(this.store, error, 'redact.markFailed');
    }
  }

  // Removes every mark that has not been applied: one undo step.
  async clear(): Promise<void> {
    if (this.snapshot.busy || this.snapshot.marks.length === 0) return;
    try {
      const changed = await removeRedactionMarks(
        this.deps.rpc,
        this.deps.handle,
        this.snapshot.marks,
      );
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
      this.update({ marks: [] });
    } catch (error) {
      reportActionError(this.store, error, 'redact.markFailed');
    }
  }

  // Applies the marks. The caller has asked the user to confirm (the apply cannot be saved away).
  // Cancel ends the job and leaves the document as it was; the marks stay for another try.
  async apply(): Promise<void> {
    if (this.snapshot.busy || this.snapshot.marks.length === 0) return;
    const marks = this.snapshot.marks;
    this.update({ busy: true });
    try {
      const outcome = await applyRedactions(
        { engine: this.deps.rpc, startWorker: this.deps.startWorker, progress: this.progress },
        this.deps.handle,
        marks,
      );
      this.deps.scheduler.noteRevisions(outcome.changed?.revisions ?? {});
      this.update({ marks: [], busy: false });
      this.store.push(
        'success',
        t('redact.applied'),
        undoAction(() => void this.undo()),
      );
    } catch (error) {
      this.update({ busy: false });
      if (!(error instanceof ActionJobCancelled))
        reportActionError(this.store, error, 'redact.applyFailed');
    }
  }

  private async undo(): Promise<void> {
    try {
      const changed = await undoLastStep(this.deps.rpc, this.deps.handle);
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
    } catch (error) {
      reportActionError(this.store, error, 'redact.applyFailed');
    }
  }
}
