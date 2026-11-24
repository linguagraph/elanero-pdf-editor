// The shared shell of the marks dialogs (W7.3, design section 5.1). It reads the document's marks of
// one kind when it opens. With none, it shows the kind's form. With some, it asks first what to do
// (Replace, Add New or Remove), which folds the desktop's Add and Update menus and message box into
// one step. The form is the dialog's own component: it reports whether it can run and the action's
// arguments, and the shell runs them as one action job, so each mark is one undo step.
import {
  type ComponentType,
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import {
  ActionJobCancelled,
  type ActionJobOutcome,
  type ActionJobWorker,
} from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import type { JobProgressStore } from '../feedback/jobRun';
import { offerUndo } from '../feedback/undoToast';
import { type ToastStore, toasts } from '../feedback/toasts';
import type { MessageId } from '../i18n/en';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { ChangedDto, MarkKind } from '../rpc/generated';
import {
  fromMarkDetail,
  getMark,
  MARK_KIND_LABELS,
  type MarkPreFill,
  markPages,
  type MarkScope,
  REMOVE_ACTION,
  removeArgs,
  runMark,
} from './marks';
import './marks.css';

// What a form reports to the shell: whether it can run for these pages, why not, and the action's
// arguments for the pages and the replace flag the shell chose.
// The arguments of one action, as the job takes them.
export type MarkArgs = Record<string, unknown>;

export interface MarkDraft {
  readonly action: string;
  readonly ready: boolean;
  readonly reason: MessageId | null;
  readonly args: (pages: readonly number[], replace: boolean) => MarkArgs;
}

export interface MarkFormProps {
  // The stored marks being updated; undefined for a new mark (Add New, or no marks in the document).
  readonly pre: MarkPreFill | undefined;
  // The chosen pages; empty while the page range is not valid.
  readonly pages: readonly number[];
  readonly onDraft: (draft: MarkDraft | null) => void;
}

export interface MarkDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly engine: PageRpc;
  readonly handle: string;
  readonly startWorker: () => ActionJobWorker;
  readonly kind: MarkKind;
  readonly titleKey: MessageId;
  readonly subtitleKey: MessageId;
  readonly form: ComponentType<MarkFormProps>;
  readonly pageCount: number;
  // One-based, as the view reports it.
  readonly currentPage: number;
  // A signed document is allowed, with a note that its signatures will show the change.
  readonly signed: boolean;
  // Redraws the pages a mark (or its Undo) changed. The app passes the view's scheduler here.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly progress?: JobProgressStore;
  readonly store?: ToastStore;
}

type View =
  | { readonly phase: 'checking' }
  | { readonly phase: 'failed' }
  | { readonly phase: 'existing'; readonly pre: MarkPreFill }
  | { readonly phase: 'form'; readonly pre: MarkPreFill | undefined };

const NO_PAGES: readonly number[] = [];

// Where an Update's scope starts: All when the marks are on every page, Current when they are on
// the current page, else the stored pages as a typed range (as PageRangeBox.select_pages does).
function scopeOf(
  pre: MarkPreFill,
  pageCount: number,
  currentPage: number,
): { readonly scope: MarkScope; readonly range: string } {
  if (pageCount > 0 && pre.pages.length === pageCount) return { scope: 'all', range: '' };
  const [only] = pre.pages;
  if (pre.pages.length === 1 && only === currentPage - 1) return { scope: 'current', range: '' };
  return { scope: 'range', range: pre.ranges };
}

export function MarkDialog(props: MarkDialogProps) {
  const {
    isOpen,
    onClose,
    engine,
    handle,
    startWorker,
    kind,
    titleKey,
    subtitleKey,
    form: Form,
    pageCount,
    currentPage,
    signed,
    onChanged,
    progress,
    store = toasts,
  } = props;
  const ids = useId();
  const [view, setView] = useState<View>({ phase: 'checking' });
  const [scope, setScope] = useState<MarkScope>('all');
  const [range, setRange] = useState('');
  const [draft, setDraft] = useState<MarkDraft | null>(null);
  // A dialog opened again starts from the check, not from the form of its last open.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setView({ phase: 'checking' });
      setScope('all');
      setRange('');
      setDraft(null);
    }
  }

  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    getMark(engine, handle, kind).then(
      (detail) => {
        if (!live) return;
        const pre = fromMarkDetail(detail);
        setView(pre ? { phase: 'existing', pre } : { phase: 'form', pre: undefined });
      },
      () => {
        if (live) setView({ phase: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [isOpen, engine, handle, kind]);

  // The pages the scope names, or undefined while a typed range is not valid.
  const pages = useMemo(
    () => markPages(scope, range, pageCount, currentPage),
    [scope, range, pageCount, currentPage],
  );
  const formPages = pages ?? NO_PAGES;
  const scopeInvalid = scope === 'range' && pages === undefined;
  const updating = view.phase === 'form' && view.pre !== undefined;
  const kindLabel = t(MARK_KIND_LABELS[kind]);

  // Runs a job the dialog has closed for. Its Undo offer redraws the pages again; a cancelled job
  // shows nothing, and a failed one says so.
  const settle = (job: Promise<ActionJobOutcome>, text: string) => {
    job.then(
      (outcome) => {
        onChanged?.(outcome.changed);
        offerUndo('info', text, {
          rpc: engine,
          handle,
          history: outcome.history,
          onUndone: (undone) => onChanged?.(undone.changed),
          store,
        });
      },
      (failure: unknown) => {
        if (failure instanceof ActionJobCancelled) return;
        reportActionError(store, failure, 'marks.failed');
      },
    );
  };

  const jobDeps = { engine, startWorker, progress };

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft === null || !draft.ready || pages === undefined) return;
    const args = draft.args(pages, updating);
    onClose();
    settle(runMark(jobDeps, handle, draft.action, args), t('marks.done.added'));
  };

  const removeMarks = (pre: MarkPreFill) => {
    onClose();
    const text = tp('marks.done.removed', pre.pages.length, { kind: kindLabel });
    settle(runMark(jobDeps, handle, REMOVE_ACTION, removeArgs(kind)), text);
  };

  const chooseUpdate = (pre: MarkPreFill) => {
    const start = scopeOf(pre, pageCount, currentPage);
    setScope(start.scope);
    setRange(start.range);
    setView({ phase: 'form', pre });
  };

  const addNew = () => {
    setScope('all');
    setRange('');
    setView({ phase: 'form', pre: undefined });
  };

  const titleText =
    view.phase === 'form' && view.pre !== undefined
      ? t('marks.update.title', { name: kindLabel })
      : t(titleKey);
  const reason = draft !== null && !draft.ready && !scopeInvalid ? draft.reason : null;
  const ready = draft !== null && draft.ready && pages !== undefined;

  let body: ReactNode;
  if (view.phase === 'checking') {
    body = <p role="status">{t('marks.loading')}</p>;
  } else if (view.phase === 'failed') {
    body = (
      <div className="mark-existing">
        <p role="alert">{t('marks.readFailed')}</p>
        <div className="mark-actions">
          <button type="button" onClick={onClose}>
            {t('marks.cancel')}
          </button>
        </div>
      </div>
    );
  } else if (view.phase === 'existing') {
    const { pre } = view;
    body = (
      <div className="mark-existing">
        <p>{tp('marks.existing', pre.pages.length, { kind: kindLabel })}</p>
        <p>{t('marks.existing.pages', { ranges: pre.ranges })}</p>
        <div className="mark-actions">
          <button type="button" autoFocus onClick={() => chooseUpdate(pre)}>
            {t('marks.replace', { kind: kindLabel })}
          </button>
          <button type="button" onClick={addNew}>
            {t('marks.addNew')}
          </button>
          <button type="button" onClick={() => removeMarks(pre)}>
            {t('marks.remove')}
          </button>
          <button type="button" onClick={onClose}>
            {t('marks.cancel')}
          </button>
        </div>
      </div>
    );
  } else {
    const { pre } = view;
    const rangeError = `${ids}-range-error`;
    body = (
      <form className="mark-form" onSubmit={apply} noValidate>
        <p className="mark-subtitle">{t(subtitleKey)}</p>
        {updating && pre?.foreign ? <p className="mark-note">{t('marks.foreignNote')}</p> : null}
        {updating && pre?.fontDropped ? (
          <p className="mark-note">{t('marks.fontDroppedNote')}</p>
        ) : null}
        {signed ? <p className="mark-note">{t('marks.signedNote')}</p> : null}
        <fieldset className="mark-scope">
          <legend>{t('marks.scope.legend')}</legend>
          <label className="mark-scope-option">
            <input
              type="radio"
              name={`${ids}-scope`}
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />
            {t('marks.scope.all')}
          </label>
          <label className="mark-scope-option">
            <input
              type="radio"
              name={`${ids}-scope`}
              checked={scope === 'current'}
              onChange={() => setScope('current')}
            />
            {t('marks.scope.current')}
          </label>
          <label className="mark-scope-option">
            <input
              type="radio"
              name={`${ids}-scope`}
              checked={scope === 'range'}
              onChange={() => setScope('range')}
            />
            {t('marks.scope.range')}
            <input
              type="text"
              className="mark-range"
              aria-label={t('marks.scope.range')}
              aria-invalid={scopeInvalid}
              aria-describedby={scopeInvalid ? rangeError : undefined}
              value={range}
              onChange={(event) => {
                setRange(event.target.value);
                setScope('range');
              }}
            />
          </label>
        </fieldset>
        {scopeInvalid ? (
          <p role="alert" id={rangeError} className="mark-error">
            {t('marks.scope.rangeInvalid')}
          </p>
        ) : null}
        <Form pre={view.pre} pages={formPages} onDraft={setDraft} />
        <p aria-live="polite" className="mark-reason">
          {reason === null ? '' : t(reason)}
        </p>
        <div className="mark-actions">
          <button type="submit" disabled={!ready}>
            {t('marks.apply')}
          </button>
          <button type="button" onClick={onClose}>
            {t('marks.cancel')}
          </button>
        </div>
      </form>
    );
  }

  return (
    <Overlay isOpen={isOpen} onClose={onClose} title={titleText} showCloseButton={false}>
      {body}
    </Overlay>
  );
}
