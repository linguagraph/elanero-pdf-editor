// The signed-document warning for the Edit tool (W6.7a S4). An edit invalidates the signatures, so
// the user confirms once per tab; Cancel (or Escape, or a tap outside) leaves the tool off.
import { Button } from 'react-aria-components';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';

export interface SignedWarningProps {
  readonly isOpen: boolean;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
}

export function SignedWarningDialog({ isOpen, onAccept, onCancel }: SignedWarningProps) {
  return (
    <Overlay
      isOpen={isOpen}
      onClose={onCancel}
      title={t('edit.signed.title')}
      showCloseButton={false}
    >
      <p>{t('edit.signed.body')}</p>
      <div className="overlay-actions">
        <Button className="overlay-close" onPress={onCancel}>
          {t('edit.signed.cancel')}
        </Button>
        <Button className="overlay-close" onPress={onAccept}>
          {t('edit.signed.continue')}
        </Button>
      </div>
    </Overlay>
  );
}
