import { Button } from 'react-aria-components';
import { displayKeys, effectiveKeys, isMacPlatform } from '../commands/shortcuts';
import { type CommandState, type Registry } from '../commands/registry';
import { isVisible } from '../commands/run';
import { t } from '../i18n/t';
import './palette.css';

const IS_MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);

export interface ShortcutListProps {
  registry: Registry;
  state: CommandState;
  // The palette shows a Back button that returns to its command list. The Keyboard Shortcuts
  // dialog has no list to return to, so it passes nothing.
  onBack?: () => void;
}

// The keyboard shortcuts help: every visible command with a binding, from the effective keys (the
// web override where there is one). Shared by the command palette and the Keyboard Shortcuts dialog.
export function ShortcutList({ registry, state, onBack }: ShortcutListProps) {
  const bound = registry.commands
    .filter((def) => isVisible(def, state))
    .map((def) => ({ def, keys: effectiveKeys(def.id) }))
    .filter((entry) => entry.keys.length > 0);
  return (
    <div className="palette">
      {onBack === undefined ? null : (
        <Button className="palette-back" onPress={onBack}>
          {t('palette.back')}
        </Button>
      )}
      <h2 className="palette-heading">{t('palette.shortcutsList')}</h2>
      {bound.length === 0 ? (
        <p className="palette-empty">{t('palette.noShortcuts')}</p>
      ) : (
        <dl className="palette-shortcuts">
          {bound.map(({ def, keys }) => (
            <div key={def.id} className="palette-shortcut-row">
              <dt>{t(def.labelId)}</dt>
              <dd>
                <kbd>{displayKeys(keys, IS_MAC)}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
