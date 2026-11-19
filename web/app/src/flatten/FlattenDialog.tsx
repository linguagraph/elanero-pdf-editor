// The flatten dialog (W7.9, W1.5 section 9): a confirmation that flattening is permanent for the
// saved file, then the flatten as an action job. Cancel does nothing. Confirm closes the dialog and
// the job bar shows the progress and its own Cancel; on success the view redraws and a toast says so.
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import { reportActionError } from '../actionJob/errors';
import type { PageRpc } from '../engine/engineConnection';
import type { JobProgressStore } from '../feedback/jobRun';
import { type ToastStore, toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { ChangedDto } from '../rpc/generated';
import { runFlatten } from './flatten';
import '../redaction/redaction.css';

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

export function FlattenDialog({
  isOpen,
  onClose,
  engine,
  handle,
  startWorker,
  onChanged,
  progress,
  store = toasts,
}: FlattenDialogProps) {
  const confirm = () => {
    onClose();
    runFlatten({ engine, startWorker, progress }, handle).then(
      (outcome) => {
        onChanged?.(outcome.changed);
        store.push('info', t('flatten.done'));
      },
      (failure: unknown) => {
        // The user's own Cancel shows nothing; the job bar reports the other failures.
        if (failure instanceof ActionJobCancelled) return;
        reportActionError(store, failure, 'flatten.failed');
      },
    );
  };

  return (
    <Overlay isOpen={isOpen} onClose={onClose} title={t('flatten.title')} showCloseButton={false}>
      <div className="redact-confirm">
        <p>{t('flatten.confirm.body')}</p>
        <div className="redact-actions">
          <button type="button" onClick={confirm}>
            {t('flatten.confirm.run')}
          </button>
          <button type="button" onClick={onClose}>
            {t('flatten.confirm.cancel')}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
