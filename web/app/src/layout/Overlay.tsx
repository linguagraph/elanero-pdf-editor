import type { ReactNode } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import { t } from '../i18n/t';
import './layout.css';

export interface OverlayProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  // A dialog with its own actions (Apply and Cancel) hides the built-in Close button.
  showCloseButton?: boolean;
}

// The modal host for dialogs and the start screen (W1.6 sections 5 and 8). react-aria provides the
// focus trap (focus stays inside, and returns to the invoker on close), Escape to close and a tap
// outside to close, so none of that is written here.
export function Overlay({
  isOpen,
  onClose,
  title,
  children,
  showCloseButton = true,
}: OverlayProps) {
  return (
    <ModalOverlay
      className="overlay-backdrop"
      isOpen={isOpen}
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal className="overlay-modal">
        <Dialog className="overlay-dialog">
          {({ close }) => (
            <>
              <Heading slot="title" className="overlay-title">
                {title}
              </Heading>
              <div className="overlay-body">{children}</div>
              {showCloseButton ? (
                <div className="overlay-actions">
                  <Button className="overlay-close" onPress={close}>
                    {t('overlay.close')}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
