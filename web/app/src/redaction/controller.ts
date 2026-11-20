// The redaction state of one open document (W7.4, W7.4b): whether the mark tool is on, the
// document's redaction marks (the ones drawn here, the ones an undo brought back, and the ones
// already in the file), the panel's selection, and the apply while it runs. The marks are read from
// the engine (redaction.list) and reloaded after every change, so the list is the document's and
// never this tab's alone. The view reads it through subscribe/getSnapshot, so it has no React in it
// and the tests can drive it directly. Every change to the document goes through the calls in
// redaction.ts, which are Commands on the engine side.
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRect } from '../comments/coordinates';
import type { PageRpc } from '../engine/engineConnection';
import type { PageArea } from '../text/textLayer';
import { type JobProgressStore, jobProgress } from '../feedback/jobRun';
import { offerUndo } from '../feedback/undoToast';
import { toasts, type ToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { ColorJson } from '../prefs/colour';
import { RpcError } from '../rpc/client';
import type { ColorDto, RedactionMarkDto } from '../rpc/generated';
import type { RenderScheduler } from '../view/renderScheduler';
import { type MarkRef, type MarkStylePatch, pageAreaJson } from './marks';
import {
  addRedactionAreas,
  addRedactionMark,
  applyRedactions,
  listRedactionMarks,
  type MarksResult,
  removeRedactionMarks,
  restyleRedactionMarks,
} from './redaction';

// One mark of the document, as redaction.list lists it (RedactionMarkDto, colours without alpha).
export interface RedactionMark extends MarkRef {
  readonly rect: PageRect;
  // The box colour after apply; null when the file has none (the engine draws it black).
  readonly fill: ColorJson | null;
  readonly overlayText: string;
  readonly textColor: ColorJson | null;
  readonly contents: string;
  readonly author: string;
  readonly locked: boolean;
}

export interface RedactionDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions' | 'subscribeRevisions'>;
  readonly startWorker: () => ActionJobWorker;
  readonly store?: ToastStore;
  readonly progress?: JobProgressStore;
}

export interface RedactionSnapshot {
  // The mark tool is on: a drag on a page marks an area.
  readonly active: boolean;
  // The document's marks, in the order the engine lists them (page, then annotation order).
  readonly marks: readonly RedactionMark[];
  // The panel's selection. Pruned to the marks that still exist on every reload.
  readonly selected: readonly MarkRef[];
  // An apply is running.
  readonly busy: boolean;
  // The first list has come back, so an empty marks list means the document has none.
  readonly loaded: boolean;
}

function colorOf(dto: ColorDto | null): ColorJson | null {
  return dto === null ? null : { r: dto.r, g: dto.g, b: dto.b };
}

export function redactionMarkOf(dto: RedactionMarkDto): RedactionMark {
  return {
    page: dto.page,
    name: dto.name,
    rect: { x0: dto.rect.x0, y0: dto.rect.y0, x1: dto.rect.x1, y1: dto.rect.y1 },
    fill: colorOf(dto.fill),
    overlayText: dto.overlay_text,
    textColor: colorOf(dto.text_color),
    contents: dto.contents,
    author: dto.author,
    locked: dto.locked,
  };
}

function sameMark(a: MarkRef, b: MarkRef): boolean {
  return a.page === b.page && a.name === b.name;
}

export class RedactionController {
  private snapshot: RedactionSnapshot = {
    active: false,
    marks: [],
    selected: [],
    busy: false,
    loaded: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly store: ToastStore;
  private readonly progress: JobProgressStore;
  // The reload in flight, if any. A reload asked for meanwhile runs once more after it.
  private reloading: Promise<void> | null = null;
  private reloadQueued = false;

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

  // Starts keeping the list in step with the document: one reload now, and one on each change that
  // moves a revision (an own call, an undo from any path, a job). Returns the stop.
  start(): () => void {
    const stop = this.deps.scheduler.subscribeRevisions(() => void this.reload());
    void this.reload();
    return stop;
  }

  setActive(active: boolean): void {
    if (this.snapshot.active !== active) this.update({ active });
  }

  // Reads the document's marks. Calls that come in while one is in flight are merged into one more
  // read after it, so a burst of changes costs two reads, not one each.
  reload(): Promise<void> {
    if (this.reloading === null) this.reloading = this.runReloads();
    else this.reloadQueued = true;
    return this.reloading;
  }

  private async runReloads(): Promise<void> {
    try {
      do {
        this.reloadQueued = false;
        await this.fetchMarks();
      } while (this.reloadQueued);
    } finally {
      this.reloading = null;
    }
  }

  private async fetchMarks(): Promise<void> {
    try {
      const reply = await listRedactionMarks(this.deps.rpc, this.deps.handle);
      const marks = reply.marks.map(redactionMarkOf);
      const selected = this.snapshot.selected.filter((ref) =>
        marks.some((mark) => sameMark(mark, ref)),
      );
      this.update({ marks, selected, loaded: true });
    } catch {
      // The list keeps what it had. A failed read is not something the user can act on (a closed
      // document is the usual cause), and the next change reads the list again.
    }
  }

  // Marks one box drawn on a page. Refused while an apply runs, since the document is read-only.
  async add(page: number, rect: PageRect): Promise<void> {
    await this.send(() => addRedactionMark(this.deps.rpc, this.deps.handle, page, rect));
  }

  // Marks the areas of a text selection (W4.12): one mark per area, one undo step. Resolves to the
  // number of marks added, 0 when nothing was added (busy, or the call failed).
  markAreas(areas: readonly PageArea[]): Promise<number> {
    if (areas.length === 0) return Promise.resolve(0);
    return this.send(() =>
      addRedactionAreas(this.deps.rpc, this.deps.handle, areas.map(pageAreaJson)),
    );
  }

  // Runs one mark call, then notes its revisions and reloads the list. Returns the marks added.
  private async send(mark: () => Promise<MarksResult>): Promise<number> {
    if (this.snapshot.busy) return 0;
    let added: number;
    try {
      const { marks, changed } = await mark();
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
      added = marks.length;
    } catch (error) {
      reportActionError(this.store, error, 'redact.markFailed');
      return 0;
    }
    void this.reload();
    return added;
  }

  // Deletes the named marks: one undo step. A name the document no longer has is ignored.
  async remove(refs: readonly MarkRef[]): Promise<void> {
    if (this.snapshot.busy || refs.length === 0) return;
    try {
      const changed = await removeRedactionMarks(this.deps.rpc, this.deps.handle, refs);
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
    } catch (error) {
      reportActionError(this.store, error, 'redact.markFailed');
      return;
    }
    void this.reload();
  }

  // Removes every mark of the document that has not been applied. The marks from the file go too:
  // the same as deleting each one.
  clear(): Promise<void> {
    return this.remove(this.snapshot.marks);
  }

  // Changes the fields the patch sets on the named marks: one undo step. A mark that is gone
  // (another tab, an undo) is refused with STALE_OBJECT, so the list is read again and the user
  // told why.
  async restyle(refs: readonly MarkRef[], patch: MarkStylePatch): Promise<void> {
    if (this.snapshot.busy || refs.length === 0) return;
    try {
      const changed = await restyleRedactionMarks(this.deps.rpc, this.deps.handle, refs, patch);
      this.deps.scheduler.noteRevisions(changed?.revisions ?? {});
    } catch (error) {
      if (error instanceof RpcError && error.code === 'STALE_OBJECT') {
        await this.reload();
        this.store.push('warning', t('redactions.stale'));
        return;
      }
      reportActionError(this.store, error, 'redactions.editFailed');
      return;
    }
    void this.reload();
  }

  // Sets the panel's selection (the marks of the list, by page and name).
  select(refs: readonly MarkRef[]): void {
    this.update({ selected: [...refs] });
  }

  // Applies the named marks, or every mark of the document when refs is null (the file's marks
  // too). The caller has asked the user to confirm (the apply cannot be saved away). Cancel ends
  // the job and leaves the document as it was; the marks stay for another try.
  async apply(refs: readonly MarkRef[] | null): Promise<void> {
    if (this.snapshot.busy) return;
    if (refs === null ? this.snapshot.marks.length === 0 : refs.length === 0) return;
    this.update({ busy: true });
    try {
      const outcome = await applyRedactions(
        { engine: this.deps.rpc, startWorker: this.deps.startWorker, progress: this.progress },
        this.deps.handle,
        refs,
      );
      this.deps.scheduler.noteRevisions(outcome.changed?.revisions ?? {});
      this.update({ busy: false });
      offerUndo('success', t('redact.applied'), {
        rpc: this.deps.rpc,
        handle: this.deps.handle,
        history: outcome.history,
        onUndone: (undone) => {
          this.deps.scheduler.noteRevisions(undone.changed?.revisions ?? {});
          void this.reload();
        },
        store: this.store,
      });
      void this.reload();
    } catch (error) {
      this.update({ busy: false });
      if (!(error instanceof ActionJobCancelled))
        reportActionError(this.store, error, 'redact.applyFailed');
    }
  }
}

// Whether a mark is in the selection (both by page and name).
export function isSelectedMark(selected: readonly MarkRef[], mark: MarkRef): boolean {
  return selected.some((ref) => sameMark(ref, mark));
}

// The boxes of the selected marks that lie on one page, for the viewer's outline (W7.4b S4).
export function selectedRectsOn(state: RedactionSnapshot, page: number): PageRect[] {
  return state.marks
    .filter((mark) => mark.page === page && isSelectedMark(state.selected, mark))
    .map((mark) => mark.rect);
}
