// The owner (permissions) password step (W7.5 S4), shown inside a security dialog when the
// document is encrypted and this session has no owner access. The typed value is this component's
// state only and is dropped on unmount. A wrong answer is shown inline, and the same wrong value
// is not offered again (no automatic retries).
import { useId, useState } from 'react';
import { t } from '../i18n/t';
import { type SecurityDeps, unlockOwner } from './security';

export interface OwnerUnlockProps {
  readonly deps: SecurityDeps;
  readonly onUnlocked: () => void;
  readonly onCancel: () => void;
}

export function OwnerUnlock({ deps, onUnlocked, onCancel }: OwnerUnlockProps) {
  const id = useId();
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSubmit = !busy && value !== '' && value !== wrong;

  const submit = async () => {
    setBusy(true);
    const outcome = await unlockOwner(deps, value);
    setBusy(false);
    if (outcome === 'unlocked') {
      setValue('');
      onUnlocked();
    } else if (outcome === 'wrong') {
      setWrong(value);
    }
  };

  return (
    <form
      className="security-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <p id={`${id}-body`}>{t('security.owner.body')}</p>
      <div className="security-field">
        <label htmlFor={`${id}-input`}>{t('security.owner.label')}</label>
        <input
          id={`${id}-input`}
          type="password"
          autoComplete="off"
          autoFocus
          aria-describedby={`${id}-body`}
          value={value}
          onChange={(event) => {
            setValue(event.currentTarget.value);
          }}
        />
      </div>
      {wrong !== null ? (
        <p className="security-problem" role="alert">
          {t('security.owner.wrong')}
        </p>
      ) : null}
      <div className="overlay-actions">
        <button type="button" className="overlay-close" onClick={onCancel}>
          {t('action.cancel')}
        </button>
        <button type="submit" className="feedback-primary" disabled={!canSubmit}>
          {t('security.owner.unlock')}
        </button>
      </div>
    </form>
  );
}
