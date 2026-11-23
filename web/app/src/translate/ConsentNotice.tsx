// The notice shown before translation is first turned on (W6.6 section 7). Nothing is sent before
// the user agrees. Cancel comes first, so it takes the initial focus; Escape cancels too. The privacy
// link goes through the link confirmation, and the notice stays open behind it.
import { useState } from 'react';
import { Button } from 'react-aria-components';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { LinkConfirmDialog } from '../links/LinkConfirmDialog';
import { classifyUri, type LinkConfirm } from '../links/linkTarget';

export interface ConsentNoticeProps {
  readonly isOpen: boolean;
  // The service's privacy policy, from translation.info; the link is left out until it is known.
  readonly privacyUrl: string | undefined;
  readonly onAgree: () => void;
  readonly onCancel: () => void;
}

export function ConsentNotice({ isOpen, privacyUrl, onAgree, onCancel }: ConsentNoticeProps) {
  const [link, setLink] = useState<LinkConfirm | null>(null);
  const openPrivacy = () => {
    if (privacyUrl === undefined) return;
    const action = classifyUri(privacyUrl);
    if (action.action === 'confirm') setLink(action);
  };
  return (
    <>
      <Overlay
        isOpen={isOpen}
        onClose={onCancel}
        title={t('translate.notice.title')}
        showCloseButton={false}
      >
        <p>{t('translate.notice.body')}</p>
        <div className="overlay-actions">
          <Button className="overlay-close" autoFocus onPress={onCancel}>
            {t('translate.notice.cancel')}
          </Button>
          {privacyUrl === undefined ? null : (
            <Button className="overlay-close" onPress={openPrivacy}>
              {t('translate.notice.privacy')}
            </Button>
          )}
          <Button className="overlay-close" onPress={onAgree}>
            {t('translate.notice.agree')}
          </Button>
        </div>
      </Overlay>
      <LinkConfirmDialog target={link} onClose={() => setLink(null)} />
    </>
  );
}
