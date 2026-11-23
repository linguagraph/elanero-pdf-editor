import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { effectiveKeys, isAlwaysPrevented } from '../commands/bindings';
import {
  commandForEvent,
  displayKeys,
  isMacPlatform,
  PALETTE_SHORTCUT_ID,
} from '../commands/shortcuts';
import { useShortcutBindings } from '../commands/useShortcutBindings';
import {
  type CommandDef,
  type CommandState,
  DISABLED_REASON_LABELS,
  type Registry,
  TAB_LABELS,
} from '../commands/registry';
import { type CommandHandlers, commandDisabledReason, runCommand } from '../commands/run';
import { t } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { rankCommands } from './match';
import {
  OPEN_COMMAND_PALETTE_EVENT,
  type PaletteSeed,
  type PaletteView,
} from './openCommandPalette';
import { readRecentCommands, recordRecentCommand } from './recentCommands';
import { ShortcutList } from './ShortcutList';
import './palette.css';

// The registry command that opens the keyboard shortcuts list inside the palette.
export const KEYBOARD_SHORTCUTS_ID = 'keyboard-shortcuts';

// Commands that move focus (Go to Page focuses the page field). They run only after the palette has
// closed: while its focus scope is mounted, the scope pulls focus back, and on unmount it restores
// focus to the invoker, which would undo the move.
const FOCUS_AFTER_CLOSE_IDS: ReadonlySet<string> = new Set(['go-to-page']);

const IS_MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);

export interface CommandPaletteProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
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
  const [view, setView] = useState<PaletteView>('commands');
  // The query the commands list starts with (a seeded opening, such as the Search tools box).
  const [seedQuery, setSeedQuery] = useState('');
  const pendingRun = useRef<CommandDef | null>(null);

  // Opens the palette with the seed. An open palette keeps its own state.
  const open = useCallback(
    (seed: PaletteSeed = {}): void => {
      if (isOpen) return;
      setView(seed.view ?? 'commands');
      setSeedQuery(seed.query ?? '');
      setIsOpen(true);
    },
    [isOpen],
  );

  useEffect(() => {
    function onOpen(event: Event): void {
      open((event as CustomEvent<PaletteSeed>).detail);
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
  }, [open]);

  // Runs a focus-moving command once the palette's Overlay has unmounted and restored focus. The
  // frame is requested in this effect, which runs after that restore has been scheduled.
  useEffect(() => {
    if (isOpen || pendingRun.current === null) return;
    const def = pendingRun.current;
    pendingRun.current = null;
    requestAnimationFrame(() => {
      if (runCommand(registry, def.id, state, handlers)) recordRecentCommand(def.id);
    });
  }, [isOpen, registry, state, handlers]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented) return;
      // Ctrl+O, Ctrl+S and Ctrl+P never reach the browser's own dialogs, bound or not (W4.x).
      if (isAlwaysPrevented(event, IS_MAC)) event.preventDefault();
      const id = commandForEvent(event, registry, state, IS_MAC);
      if (id === undefined) return;
      if (id === PALETTE_SHORTCUT_ID) {
        event.preventDefault();
        open();
        return;
      }
      if (isOpen || isTextEntry(event.target)) return;
      // Ctrl+S is kept even when Save cannot run yet (no document): the browser's own Save
      // dialog must not open over the app (W4.8).
      if (runCommand(registry, id, state, handlers) || id === 'save') event.preventDefault();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [registry, state, handlers, isOpen, open]);

  function run(def: CommandDef): void {
    if (def.id === KEYBOARD_SHORTCUTS_ID) {
      setView('shortcuts');
      return;
    }
    if (commandDisabledReason(def, state, handlers) !== null) return;
    setIsOpen(false);
    if (FOCUS_AFTER_CLOSE_IDS.has(def.id)) {
      pendingRun.current = def;
      return;
    }
    // Only a run from the palette counts as recent (W4.3b D2), and only once it has happened.
    if (runCommand(registry, def.id, state, handlers)) recordRecentCommand(def.id);
  }

  return (
    <Overlay
      isOpen={isOpen}
      onClose={() => setIsOpen(false)}
      title={t('palette.title')}
      showCloseButton={false}
    >
      {view === 'commands' ? (
        <CommandList
          registry={registry}
          state={state}
          handlers={handlers}
          initialQuery={seedQuery}
          onRun={run}
        />
      ) : (
        <ShortcutList registry={registry} state={state} onBack={() => setView('commands')} />
      )}
    </Overlay>
  );
}

interface CommandListProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
  initialQuery: string;
  onRun: (def: CommandDef) => void;
}

// The ribbon tab a command lives on, or the app menu for a group that has no tab.
function locationLabel(registry: Registry, def: CommandDef): string {
  const tab = registry.groups.find((group) => group.id === def.group)?.tab ?? null;
  return tab === null ? t('palette.menuLocation') : t(TAB_LABELS[tab]);
}

// The search box and the list. The input keeps focus and drives the list through
// aria-activedescendant (the combobox pattern), so the arrow keys move the highlight, not the focus.
// The list is read once per opening (the Overlay unmounts it when closed), so a run shows next time.
function CommandList({ registry, state, handlers, initialQuery, onRun }: CommandListProps) {
  // Re-renders the rows when a shortcut changes, so each row shows the key the web now binds.
  useShortcutBindings();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const [recent] = useState(() => readRecentCommands());
  const listId = useId();
  const matches = rankCommands(registry, state, query, recent);
  const rows = matches.map((match) => match.def);
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
          {matches.map(({ def, recentRank }, position) => {
            const reason = commandDisabledReason(def, state, handlers);
            const keys = effectiveKeys(def.id);
            const isRecent = recentRank !== Infinity;
            return (
              <li
                key={def.id}
                id={optionId(position)}
                role="option"
                aria-selected={position === index}
                aria-disabled={reason === null ? undefined : 'true'}
                data-command={def.id}
                data-active={position === index ? 'true' : undefined}
                data-recent={isRecent ? 'true' : undefined}
                className="palette-row"
                onMouseMove={() => setActive(position)}
                onClick={() => onRun(def)}
              >
                <span className="palette-label">{t(def.labelId)}</span>
                {isRecent ? <span className="palette-recent">{t('palette.recent')}</span> : null}
                <span className="palette-tab">{locationLabel(registry, def)}</span>
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
