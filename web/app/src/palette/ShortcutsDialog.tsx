import type { CommandState, Registry } from '../commands/registry';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { ShortcutList } from './ShortcutList';

export interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  registry: Registry;
  state: CommandState;
}

// The Keyboard Shortcuts dialog (W4.5 S2): opened from Preferences.
// It opens above Preferences, and Escape closes only this dialog (react-aria's modal stack).
export function ShortcutsDialog({ isOpen, onClose, registry, state }: ShortcutsDialogProps) {
  return (
    <Overlay isOpen={isOpen} onClose={onClose} title={t('palette.shortcutsList')}>
      <ShortcutList registry={registry} state={state} />
    </Overlay>
  );
}
