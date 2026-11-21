// The confirmation before a web or mail link opens (W5.3). It shows the parsed host and the full
// address as text, so what the reader checks is exactly what Open navigates to. Cancel comes first,
// so it takes the initial focus; Escape and a tap outside cancel too.
import { Button } from 'react-aria-components';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import type { LinkConfirm } from './linkTarget';
import './links.css';

export interface LinkConfirmDialogProps {
  // The link to confirm, or null when no dialog is open.
  readonly target: LinkConfirm | null;
  readonly onClose: () => void;
}

// The host is set in bold. The translated line keeps it in place with a marker, split out here, so
// the string itself stays plain text.
const HOST_MARK = '';

export function LinkConfirmDialog({ target, onClose }: LinkConfirmDialogProps) {
  return (
    <Overlay
      isOpen={target !== null}
      onClose={onClose}
      title={t('links.confirm.title')}
      showCloseButton={false}
    >
      {target === null ? null : (
        <>
          {target.scheme === 'mailto:' ? (
            <p>{t('links.confirm.mail')}</p>
          ) : (
            <HostLine host={target.host} />
          )}
          <p className="link-confirm-label">{t('links.confirm.address')}</p>
          <p className="link-confirm-address" dir="ltr">
            {target.href}
          </p>
          <p>{t('links.confirm.warning')}</p>
          <div className="overlay-actions">
            <Button className="overlay-close" autoFocus onPress={onClose}>
              {t('links.confirm.cancel')}
            </Button>
            <Button
              className="overlay-close"
              onPress={() => {
                // Synchronous in the press, so the browser still counts it as the user's click.
                window.open(target.href, '_blank', 'noopener,noreferrer');
                onClose();
              }}
            >
              {t('links.confirm.open')}
            </Button>
          </div>
        </>
      )}
    </Overlay>
  );
}

function HostLine({ host }: { readonly host: string }) {
  const [before, after = ''] = t('links.confirm.web', { host: HOST_MARK }).split(HOST_MARK);
  return (
    <p>
      {before}
      <strong>{host}</strong>
      {after}
    </p>
  );
}
