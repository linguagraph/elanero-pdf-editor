import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from 'react-aria-components';
import {
  commandForEvent,
  displayKeys,
  effectiveKeys,
  isMacPlatform,
  PALETTE_SHORTCUT_ID,
} from '../commands/shortcuts';
import {
  type CommandDef,
  type CommandState,
  DISABLED_REASON_LABELS,
  type Registry,
} from '../commands/registry';
import { type CommandHandlers, isVisible, runCommand } from '../commands/run';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import './palette.css';

// The registry command that opens the keyboard shortcuts list inside the palette.
export const KEYBOARD_SHORTCUTS_ID = 'keyboard-shortcuts';

const IS_MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);

export interface CommandPaletteProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

type View = 'commands' | 'shortcuts';

// The visible commands whose labels contain every word of the query (case-insensitive), in the
// registry's order. An empty query lists them all.
export function filterCommands(
  registry: Registry,
  state: CommandState,
  query: string,
): CommandDef[] {
  const words = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  return registry.commands
    .filter((def) => isVisible(def, state))
    .filter((def) => {
      const label = t(def.labelId).toLowerCase();
      return words.every((word) => label.includes(word));
    });
}

// Keys typed into a field are text, not shortcuts (the palette's own keys are handled apart).
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

// The command palette (W1.6 section 9, W4.3b): Ctrl+Shift+P opens it, a search box filters the
// registry's commands, and Enter runs the highlighted one through the same handlers as the ribbon.
// It also mounts the keyboard shortcut listener, which runs a command's shared or overridden key
// when the palette is closed and focus is not in a text field. The Overlay host traps focus, closes
// on Escape and returns focus to the element that had it before the palette opened.
export function CommandPalette({ registry, state, handlers }: CommandPaletteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<View>('commands');

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      const id = commandForEvent(event, registry, state, IS_MAC);
      if (id === undefined) return;
      if (id === PALETTE_SHORTCUT_ID) {
        event.preventDefault();
        if (!isOpen) {
          setView('commands');
          setIsOpen(true);
        }
        return;
      }
      if (isOpen || isTextEntry(event.target)) return;
      if (runCommand(registry, id, state, handlers)) event.preventDefault();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [registry, state, handlers, isOpen]);

  function run(def: CommandDef): void {
    if (def.id === KEYBOARD_SHORTCUTS_ID) {
      setView('shortcuts');
      return;
    }
    if (def.enabled(state) !== null) return;
    setIsOpen(false);
    runCommand(registry, def.id, state, handlers);
  }

  return (
    <Overlay
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      title={t('palette.title')}
      showCloseButton={false}
    >
      {view === 'commands' ? (
        <CommandList registry={registry} state={state} onRun={run} />
      ) : (
        <ShortcutList registry={registry} state={state} onBack={() => setView('commands')} />
      )}
    </Overlay>
  );
}

interface CommandListProps {
  registry: Registry;
  state: CommandState;
  onRun: (def: CommandDef) => void;
}

// The search box and the list. The input keeps focus and drives the list through
// aria-activedescendant (the combobox pattern), so the arrow keys move the highlight, not the focus.
function CommandList({ registry, state, onRun }: CommandListProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const rows = filterCommands(registry, state, query);
  const index = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  const optionId = (position: number): string => `${listId}-${position}`;

  function move(step: number): void {
    if (rows.length === 0) return;
    setActive((index + step + rows.length) % rows.length);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const def = rows[index];
      if (def !== undefined) onRun(def);
    }
  }

  return (
    <div className="palette">
      <input
        type="text"
        className="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={index >= 0 ? optionId(index) : undefined}
        aria-label={t('palette.search')}
        placeholder={t('palette.placeholder')}
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {rows.length === 0 ? (
        <p className="palette-empty">{t('palette.empty')}</p>
      ) : (
        <ul id={listId} role="listbox" aria-label={t('palette.commands')} className="palette-list">
          {rows.map((def, position) => {
            const reason = def.enabled(state);
            const keys = effectiveKeys(def.id);
            return (
              <li
                key={def.id}
                id={optionId(position)}
                role="option"
                aria-selected={position === index}
                aria-disabled={reason === null ? undefined : 'true'}
                data-command={def.id}
                data-active={position === index ? 'true' : undefined}
                className="palette-row"
                onMouseMove={() => setActive(position)}
                onClick={() => onRun(def)}
              >
                <span className="palette-label">{t(def.labelId)}</span>
                {keys.length > 0 ? (
                  <span className="palette-shortcut">{displayKeys(keys, IS_MAC)}</span>
                ) : null}
                {reason === null ? null : (
                  <span className="palette-reason">{t(DISABLED_REASON_LABELS[reason])}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface ShortcutListProps {
  registry: Registry;
  state: CommandState;
  onBack: () => void;
}

// The keyboard shortcuts help: every visible command with a binding, from the effective keys (the
// web override where there is one).
function ShortcutList({ registry, state, onBack }: ShortcutListProps) {
  const bound = registry.commands
    .filter((def) => isVisible(def, state))
    .map((def) => ({ def, keys: effectiveKeys(def.id) }))
    .filter((entry) => entry.keys.length > 0);
  return (
    <div className="palette">
      <Button className="palette-back" onPress={onBack}>
        {t('palette.back')}
      </Button>
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
