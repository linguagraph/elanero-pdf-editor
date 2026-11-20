// The confirmation before a redaction apply (W7.4, W7.4b S5). The removed content cannot be put
// back by saving, so the user says so first. Shared by the toolbar bar and the Redactions panel.
import { tp, t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import './redaction.css';

export interface ApplyConfirmProps {
  readonly isOpen: boolean;
  // The marks the apply will remove the content under.
  readonly count: number;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ApplyConfirm({ isOpen, count, onConfirm, onCancel }: ApplyConfirmProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onCancel}
      title={t('redact.confirm.title')}
      showCloseButton={false}
    >
      <div className="redact-confirm">
        <p>{tp('redact.confirm.body', count)}</p>
        <div className="redact-actions">
          <button type="button" onClick={onConfirm}>
            {t('redact.confirm.apply')}
          </button>
          <button type="button" onClick={onCancel}>
            {t('redact.confirm.cancel')}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
