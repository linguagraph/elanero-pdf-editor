// Mark Pages (W4.13 S3, the desktop's Mark Whole Pages): a dialog for the pages to mark whole. It
// reads the page sizes when it opens, checks the choice (markPagesChoice.ts), then marks the pages
// through the redaction controller. It marks only: nothing is applied, and a refusal shows inside
// the dialog so the choice can be changed.
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { PageRpc } from '../engine/engineConnection';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { PageSize } from '../rpc/generated';
import { type MarkPagesDeps, markWholePages } from './markPages';
import { choosePages, type MarkPagesScope, type MarkPagesValues } from './markPagesChoice';
import './redaction.css';

export interface MarkPagesDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly controller: MarkPagesDeps['controller'];
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly pageCount: number;
  // One-based, as the view reports it.
  readonly currentPage: number;
}

export function MarkPagesDialog(props: MarkPagesDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('markPages.title')}
      showCloseButton={false}
    >
      <MarkPagesForm {...props} />
    </Overlay>
  );
}

// Mounted only while the dialog is open, so every open starts from the current page and reads the
// page sizes again (the document may have changed since the last one).
function MarkPagesForm({
  onClose,
  controller,
  rpc,
  handle,
  pageCount,
  currentPage,
}: MarkPagesDialogProps) {
  const ids = useId();
  const [values, setValues] = useState<MarkPagesValues>({ scope: 'current', range: '' });
  const [sizes, setSizes] = useState<readonly PageSize[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let live = true;
    rpc.call('session.pages', { handle }).then(
      (reply) => {
        if (live) setSizes(reply.pages);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, handle]);

  const choice = choosePages(values, pageCount, currentPage);
  const chosen = choice.ok ? choice.pages.length : 0;

  const set = (patch: Partial<MarkPagesValues>) => {
    setValues((previous) => ({ ...previous, ...patch }));
    setError(null);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (running || sizes === null) return;
    if (!choice.ok) {
      setError(choice.message);
      return;
    }
    setError(null);
    setRunning(true);
    void markWholePages({ controller }, choice.pages, sizes).then(
      () => onClose(),
      () => onClose(),
    );
  };

  const option = (scope: MarkPagesScope, label: string) => (
    <label className="mark-pages-option">
      <input
        type="radio"
        name={`${ids}-scope`}
        value={scope}
        checked={values.scope === scope}
        onChange={() => set({ scope })}
      />
      {label}
    </label>
  );

  return (
    <form className="mark-pages" onSubmit={submit} noValidate>
      <p className="mark-pages-description">{t('markPages.description')}</p>
      <fieldset className="mark-pages-scope">
        <legend>{t('markPages.pages')}</legend>
        {option('current', t('markPages.pages.current', { page: currentPage }))}
        {option('all', t('markPages.pages.all', { count: pageCount }))}
        <label className="mark-pages-option">
          <input
            type="radio"
            name={`${ids}-scope`}
            value="range"
            checked={values.scope === 'range'}
            onChange={() => set({ scope: 'range' })}
          />
          {t('markPages.pages.range')}
          <input
            type="text"
            className="mark-pages-range"
            aria-label={t('markPages.pages.range')}
            value={values.range}
            onChange={(event) => set({ range: event.target.value, scope: 'range' })}
          />
        </label>
      </fieldset>
      {chosen > 1 ? (
        <p className="mark-pages-confirm" role="status">
          {tp('markPages.confirm', chosen)}
        </p>
      ) : null}
      {loadFailed ? (
        <p role="alert" className="mark-pages-error">
          {t('markPages.failed')}
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="mark-pages-error">
          {error}
        </p>
      ) : null}
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onClose} disabled={running}>
          {t('markPages.cancel')}
        </button>
        <button type="submit" disabled={running || sizes === null}>
          {t('markPages.apply')}
        </button>
      </div>
    </form>
  );
}
