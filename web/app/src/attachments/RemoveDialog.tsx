// The confirmation for removing an attachment (W7.9 A2). It names the file, says that Undo works
// until the document is closed, and has Cancel focused, as the flatten dialog does. Confirm passes
// the entry back; Cancel and Escape change nothing.
import { Overlay } from '../layout/Overlay';
import { t } from '../i18n/t';
import type { AttachmentEntry } from '../rpc/generated';
import '../redaction/redaction.css';
import { displayName } from './format';

export interface RemoveDialogProps {
  // The attachment to remove; null while the dialog is closed.
  readonly entry: AttachmentEntry | null;
  readonly onConfirm: (entry: AttachmentEntry) => void;
  readonly onCancel: () => void;
}

export function RemoveDialog({ entry, onConfirm, onCancel }: RemoveDialogProps) {
  return (
    <Overlay
      isOpen={entry !== null}
      onClose={onCancel}
      title={t('attachments.remove.title')}
      showCloseButton={false}
    >
      {entry === null ? null : (
        <div className="redact-confirm">
          <p>{t('attachments.remove.body', { name: displayName(entry) })}</p>
          <div className="redact-actions">
            <button type="button" onClick={() => onConfirm(entry)}>
              {t('attachments.remove.confirm')}
            </button>
            <button type="button" autoFocus onClick={onCancel}>
              {t('attachments.remove.cancel')}
            </button>
          </div>
        </div>
      )}
    </Overlay>
  );
}
