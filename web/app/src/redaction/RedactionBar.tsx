// The redaction tools in the document toolbar (W7.4, W1.5 section 6): the mark tool, the count of
// marks not yet applied, Clear, and Apply. Apply asks for confirmation first, since the removed
// content cannot be put back by saving. Nothing here changes the document; the controller does.
import { useState } from 'react';
import { t } from '../i18n/t';
import type { RedactionSnapshot } from './controller';
import { ApplyConfirm } from './ApplyConfirm';
import './redaction.css';

export interface RedactionBarProps {
  readonly state: RedactionSnapshot;
  readonly onToggle: () => void;
  readonly onClear: () => void;
  readonly onApply: () => void;
}

export function RedactionBar({ state, onToggle, onClear, onApply }: RedactionBarProps) {
  const [confirming, setConfirming] = useState(false);
  const count = state.marks.length;
  const idle = !state.busy && count > 0;

  return (
    <div className="redact-bar" role="group" aria-label={t('redact.toolbarLabel')}>
      <button type="button" aria-pressed={state.active} onClick={onToggle} disabled={state.busy}>
        {t('redact.mark')}
      </button>
      <span>{t('redact.count', { count })}</span>
      <button type="button" onClick={onClear} disabled={!idle}>
        {t('redact.clear')}
      </button>
      <button type="button" onClick={() => setConfirming(true)} disabled={!idle}>
        {t('redact.apply')}
      </button>
      <ApplyConfirm
        isOpen={confirming}
        count={count}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onApply();
        }}
      />
    </div>
  );
}
