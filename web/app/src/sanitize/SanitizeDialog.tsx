// The sanitize dialog (W7.4, W1.5 section 10): the items to remove, a confirmation, then the run as
// an action job. The result lists what was removed, so the user sees the report before closing.
import { useEffect, useId, useRef, useState } from 'react';
import { ActionJobCancelled, type ActionJobWorker } from '../actionJob/actionJob';
import { isEncryptedRefusal, isSignedRefusal } from '../actionJob/errors';
import type { JobProgressStore } from '../feedback/jobRun';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { PageRpc } from '../engine/engineConnection';
import type { ChangedDto } from '../rpc/generated';
import '../redaction/redaction.css';
import {
  runSanitize,
  SANITIZE_DEFAULTS,
  SANITIZE_LABEL,
  SANITIZE_OPTIONS,
  type SanitizeChoice,
  type SanitizeOption,
} from './sanitize';

export interface SanitizeDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly engine: PageRpc;
  readonly handle: string;
  readonly startWorker: () => ActionJobWorker;
  // Redraws the pages the sanitize changed. The app passes the view's scheduler here.
  readonly onChanged?: (changed: ChangedDto | null) => void;
  readonly progress?: JobProgressStore;
}

// The dialog on the Overlay host. Its form is mounted only while the dialog is open, so each open
// starts from the defaults.
export function SanitizeDialog(props: SanitizeDialogProps) {
  return (
    <Overlay
      isOpen={props.isOpen}
      onClose={props.onClose}
      title={t('sanitize.title')}
      showCloseButton={false}
    >
      <SanitizeForm {...props} />
    </Overlay>
  );
}

type Phase = 'choose' | 'confirm' | 'running' | 'done';

function SanitizeForm({
  onClose,
  engine,
  handle,
  startWorker,
  onChanged,
  progress,
}: SanitizeDialogProps) {
  const ids = useId();
  const [choice, setChoice] = useState<SanitizeChoice>(SANITIZE_DEFAULTS);
  const [phase, setPhase] = useState<Phase>('choose');
  const [removed, setRemoved] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const chosen = SANITIZE_OPTIONS.filter((option) => choice[option]);

  const run = () => {
    setError(null);
    setPhase('running');
    runSanitize({ engine, startWorker, progress }, handle, choice).then(
      (result) => {
        if (!mounted.current) return;
        setRemoved(result.removed);
        setPhase('done');
        onChanged?.(result.changed);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setPhase('choose');
        // A cancel is the user's own choice. The job bar reports other failures as a toast, so
        // this line only says the sanitize did not finish, or why it was refused.
        if (failure instanceof ActionJobCancelled) return;
        if (isEncryptedRefusal(failure)) setError(t('job.encryptedRefused'));
        else if (isSignedRefusal(failure)) setError(t('sanitize.refused.signed'));
        else setError(t('sanitize.failed'));
      },
    );
  };

  if (phase === 'done') {
    return (
      <div className="sanitize">
        <p role="status">
          {removed.length > 0 ? t('sanitize.result.heading') : t('sanitize.result.none')}
        </p>
        {removed.length > 0 ? (
          <ul className="sanitize-result">
            {removed.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
        <p>{t('sanitize.result.saveHint')}</p>
        <div className="redact-actions">
          <button type="button" onClick={onClose}>
            {t('sanitize.close')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="sanitize"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (phase === 'choose' && chosen.length > 0) setPhase('confirm');
      }}
    >
      <p>{t('sanitize.intro')}</p>
      <fieldset className="sanitize-options" disabled={phase !== 'choose'}>
        {SANITIZE_OPTIONS.map((option: SanitizeOption) => (
          <label key={option} className="sanitize-option" htmlFor={`${ids}-${option}`}>
            <input
              id={`${ids}-${option}`}
              type="checkbox"
              checked={choice[option]}
              onChange={(event) => setChoice({ ...choice, [option]: event.target.checked })}
            />
            <span>{t(SANITIZE_LABEL[option])}</span>
          </label>
        ))}
      </fieldset>
      {error !== null ? (
        <p role="alert" className="redact-error">
          {error}
        </p>
      ) : null}
      {phase === 'confirm' ? (
        <div className="redact-confirm" role="group">
          <p>{t('sanitize.confirm.body')}</p>
          <div className="redact-actions">
            <button type="button" onClick={run}>
              {t('sanitize.confirm.run')}
            </button>
            <button type="button" onClick={() => setPhase('choose')}>
              {t('sanitize.confirm.back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="redact-actions">
          <button type="submit" disabled={phase !== 'choose' || chosen.length === 0}>
            {t('sanitize.run')}
          </button>
          <button type="button" onClick={onClose} disabled={phase === 'running'}>
            {t('sanitize.close')}
          </button>
        </div>
      )}
    </form>
  );
}
