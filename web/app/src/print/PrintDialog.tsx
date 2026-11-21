// The print dialog (W6.5, W1.6 section 5): the page range, the resolution, the comments option and
// the Print button. Print refuses an empty or invalid range before any job starts. Above 200 pages
// it asks first (W6.5 section 3.5): the same dialog shows the question, Back returns to the form
// with its values kept. Then the dialog closes and the job runs; its progress bar and Cancel are
// the app's job bar.
import { useEffect, useRef, useState } from 'react';
import type { WorkerClient } from '../engine/start';
import { Overlay } from '../layout/Overlay';
import { t, tp } from '../i18n/t';
import { resolvePrintPages, type PrintScope } from './printRange';
import { runPrintJob, type PrintRpc } from './printJob';
import './print.css';

// Above this many pages the dialog warns (W1.4 section 11).
export const LARGE_PRINT_PAGES = 200;

export interface PrintDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  // The open document's engine session, or null when no document is open.
  readonly session: { readonly rpc: PrintRpc; readonly handle: string } | null;
  readonly pageCount: number;
  // One-based, as the view reports it.
  readonly currentPage: number;
  readonly startWorker: (() => WorkerClient) | undefined;
}

export function PrintDialog({
  isOpen,
  onClose,
  session,
  pageCount,
  currentPage,
  startWorker,
}: PrintDialogProps) {
  const [scope, setScope] = useState<PrintScope>('all');
  const [rangeText, setRangeText] = useState('');
  const [dpi, setDpi] = useState<150 | 300>(150);
  const [comments, setComments] = useState(true);
  const [invalid, setInvalid] = useState(false);
  // True while the question above 200 pages is shown in place of the form.
  const [confirming, setConfirming] = useState(false);
  // Set by Back, so the focus returns to the scope the user had chosen.
  const returning = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  const resolved = resolvePrintPages(scope, rangeText, pageCount, currentPage);
  const selected = resolved.ok ? (resolved.pages?.length ?? pageCount) : 0;

  // The question takes the focus when it opens, and Back puts it on the scope the user had chosen.
  useEffect(() => {
    if (confirming) {
      continueRef.current?.focus();
    } else if (returning.current) {
      returning.current = false;
      const target =
        scope === 'range'
          ? formRef.current?.querySelector<HTMLInputElement>('.print-range')
          : formRef.current?.querySelector<HTMLInputElement>(
              `input[name="print-scope"][value="${scope}"]`,
            );
      target?.focus();
    }
  }, [confirming, scope]);

  const start = (): void => {
    if (session === null || !resolved.ok) return;
    setConfirming(false);
    onClose();
    void runPrintJob({
      rpc: session.rpc,
      handle: session.handle,
      pages: resolved.pages,
      dpi,
      comments,
      startWorker,
    });
  };

  const submit = (): void => {
    if (!resolved.ok) {
      setInvalid(true);
      return;
    }
    if (session === null) return;
    setInvalid(false);
    if (selected > LARGE_PRINT_PAGES) {
      setConfirming(true);
      return;
    }
    start();
  };

  // Escape, and the close button, go back to the form while the question is up; they close only
  // from the form.
  const back = (): void => {
    returning.current = true;
    setConfirming(false);
  };
  const close = (): void => {
    if (confirming) back();
    else onClose();
  };

  return (
    <Overlay isOpen={isOpen} onClose={close} title={t('print.title')}>
      {confirming ? (
        <div className="print-confirm">
          <p>{tp('print.large.confirm', selected, { dpi })}</p>
          <div className="overlay-actions">
            <button type="button" onClick={back}>
              {t('print.large.back')}
            </button>
            <button ref={continueRef} type="button" onClick={start}>
              {tp('print.large.continue', selected)}
            </button>
          </div>
        </div>
      ) : null}
      <form
        ref={formRef}
        hidden={confirming}
        className="print-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="print-scope">
          <legend>{t('print.scope.legend')}</legend>
          <label>
            <input
              type="radio"
              name="print-scope"
              value="all"
              checked={scope === 'all'}
              onChange={() => setScope('all')}
            />{' '}
            {t('print.scope.all')}
          </label>
          <label>
            <input
              type="radio"
              name="print-scope"
              value="current"
              checked={scope === 'current'}
              onChange={() => setScope('current')}
            />{' '}
            {t('print.scope.current')}
          </label>
          <label>
            <input
              type="radio"
              name="print-scope"
              value="range"
              checked={scope === 'range'}
              onChange={() => setScope('range')}
            />{' '}
            {t('print.scope.range')}
          </label>
          <input
            type="text"
            className="print-range"
            aria-label={t('print.scope.range')}
            aria-describedby="print-range-hint"
            aria-invalid={invalid && scope === 'range'}
            disabled={scope !== 'range'}
            value={rangeText}
            onChange={(event) => {
              setRangeText(event.target.value);
              setInvalid(false);
            }}
          />
          <p id="print-range-hint" className="print-hint">
            {t('print.range.hint')}
          </p>
          {invalid ? (
            <p role="alert" className="print-error">
              {t('print.range.invalid')}
            </p>
          ) : null}
        </fieldset>
        <label>
          {t('print.dpi.label')}{' '}
          <select
            value={dpi}
            onChange={(event) => setDpi(Number(event.target.value) === 300 ? 300 : 150)}
          >
            <option value="150">{t('print.dpi.150')}</option>
            <option value="300">{t('print.dpi.300')}</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={comments}
            onChange={(event) => setComments(event.target.checked)}
          />{' '}
          {t('print.comments.label')}
        </label>
        {selected > LARGE_PRINT_PAGES ? (
          <p className="print-hint">{tp('print.large', selected)}</p>
        ) : null}
        {session === null ? <p className="print-hint">{t('print.noDocument')}</p> : null}
        <div className="overlay-actions">
          <button type="submit" disabled={session === null}>
            {t('print.start')}
          </button>
        </div>
      </form>
    </Overlay>
  );
}
