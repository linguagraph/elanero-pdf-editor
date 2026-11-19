// The flatten dialog (W7.9, W1.5 section 9). It reads the comment count when it opens: with none, it
// says so and offers no job. Otherwise it asks for a confirmation that flattening is permanent for
// the saved file (Cancel has the focus), then runs the flatten as an action job. Cancel does
// nothing. Confirm closes the dialog and the job bar shows the progress and its own Cancel; a
// finished flatten redraws the view and says so, and a failed or cancelled one changes nothing.
import { useEffect, useState } from 'react';
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import type { JobProgressStore } from '../feedback/jobRun';
import { type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { ChangedDto } from '../rpc/generated';
import '../redaction/redaction.css';
import { countFlattenable, runFlatten } from './flatten';

export interface FlattenDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly engine: PageRpc;
  readonly handle: string;
  readonly startWorker: () => ActionJobWorker;
  // Redraws the pages the flatten changed. The app passes the view's scheduler here.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly progress?: JobProgressStore;
  readonly store?: ToastStore;
}

// The comment count as the dialog reads it: null while it is read.
type Reading =
  | { readonly status: 'counting' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly count: number };

export function FlattenDialog(props: FlattenDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('flatten.title')}
      showCloseButton={false}
    >
      <FlattenBody {...props} />
    </Overlay>
  );
}

// Mounted only while the dialog is open (the Overlay unmounts its content when closed), so each
// open starts by reading the count again: the document may have changed since the last one.
function FlattenBody({
  onClose,
  engine,
  handle,
  startWorker,
  onChanged,
  progress,
  store = toasts,
}: FlattenDialogProps) {
  const [reading, setReading] = useState<Reading>({ status: 'counting' });
  useEffect(() => {
    let live = true;
    countFlattenable(engine, handle).then(
      (count) => {
        if (live) setReading({ status: 'ready', count });
      },
      () => {
        if (live) setReading({ status: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [engine, handle]);

  const confirm = () => {
    onClose();
    runFlatten({ engine, startWorker, progress }, handle).then(
      (outcome) => {
        onChanged?.(outcome.changed);
        store.push('info', t('flatten.done'));
      },
      (failure: unknown) => {
        // The user's own Cancel shows nothing and changes nothing; the job bar reports the rest.
        if (failure instanceof ActionJobCancelled) return;
        reportActionError(store, failure, 'flatten.failed');
      },
    );
  };

  if (reading.status === 'counting') {
    return <p role="status">{t('flatten.counting')}</p>;
  }
  if (reading.status === 'failed') {
    return (
      <div className="redact-confirm">
        <p role="alert">{t('flatten.failed')}</p>
        <div className="redact-actions">
          <button type="button" onClick={onClose}>
            {t('flatten.close')}
          </button>
        </div>
      </div>
    );
  }
  if (reading.count === 0) {
    return (
      <div className="redact-confirm">
        <p role="status">{t('flatten.none')}</p>
        <div className="redact-actions">
          <button type="button" onClick={onClose}>
            {t('flatten.close')}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="redact-confirm">
      <p>{t('flatten.confirm.body')}</p>
      <div className="redact-actions">
        <button type="button" onClick={confirm}>
          {t('flatten.confirm.run')}
        </button>
        <button type="button" autoFocus onClick={onClose}>
          {t('flatten.confirm.cancel')}
        </button>
      </div>
    </div>
  );
}
