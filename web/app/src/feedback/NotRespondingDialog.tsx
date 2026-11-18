// The "Elanero is still working on this" dialog (W1.1 section 1, W4.4b). It opens when an RPC call
// passes its deadline. Wait only closes it; the engine keeps running. Restart engine calls the
// caller's handler, which runs restartEngine (W3.9). The list of what is lost comes from the
// restart helper, so the dialog and the restart cannot disagree.
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { LOST_WORK } from '../engine/restart';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { lostItemText } from './lostWork';
import './feedback.css';

export function isNotRespondingError(error: unknown): boolean {
  return error instanceof RpcError && error.code === 'TIMEOUT';
}

export interface NotRespondingDialogProps {
  // The failure the caller is holding. The dialog opens for a deadline error and stays closed for
  // any other value. Wait leaves the caller to clear it.
  error: unknown;
  onWait: () => void;
  onRestart: () => void;
}

export function NotRespondingDialog({ error, onWait, onRestart }: NotRespondingDialogProps) {
  return (
    <ModalOverlay
      className="overlay-backdrop"
      isOpen={isNotRespondingError(error)}
      isDismissable={false}
      onOpenChange={(open) => {
        // Escape is Wait: it closes the dialog without touching the engine.
        if (!open) onWait();
      }}
    >
      <Modal className="overlay-modal">
        <Dialog className="overlay-dialog">
          <Heading slot="title" className="overlay-title">
            {t('engine.notResponding.title')}
          </Heading>
          <p>{t('engine.notResponding.body')}</p>
          <p>{t('engine.lost.intro')}</p>
          <ul className="feedback-lost">
            {LOST_WORK.items.map((item) => (
              <li key={item}>{lostItemText(item)}</li>
            ))}
          </ul>
          <div className="overlay-actions">
            <Button className="overlay-close" onPress={onWait}>
              {t('engine.notResponding.wait')}
            </Button>
            <Button className="feedback-primary" onPress={onRestart}>
              {t('engine.restart.confirm')}
            </Button>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
