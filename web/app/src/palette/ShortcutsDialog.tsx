import { useEffect, useId, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import {
  type ChordCheck,
  assign,
  check,
  effectiveKeys,
  reset,
  userKeys,
} from '../commands/bindings';
import { type RecordedChord, canonicalChord } from '../commands/chord';
import { PALETTE_SHORTCUT_ID, displayKeys, isMacPlatform } from '../commands/shortcuts';
import { type CommandState, type Registry } from '../commands/registry';
import { isVisible } from '../commands/run';
import { useShortcutBindings } from '../commands/useShortcutBindings';
import { t, tp } from '../i18n/t';
import { Overlay } from '../layout/Overlay';
import { KeyRecorder } from './KeyRecorder';
import './palette.css';

const IS_MAC = typeof navigator !== 'undefined' && isMacPlatform(navigator.platform);

export interface ShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  registry: Registry;
  state: CommandState;
}

// The Keyboard Shortcuts dialog (W4.x, #330): opened from Preferences. It lists every visible
// command with its keys and lets the user change them. Every change goes through the binding store,
// which checks it, so a refused key is never saved or matched.
export function ShortcutsDialog({ isOpen, onClose, registry, state }: ShortcutsDialogProps) {
  return (
    <Overlay isOpen={isOpen} onClose={onClose} title={t('palette.shortcutsList')}>
      <ShortcutEditor registry={registry} state={state} />
    </Overlay>
  );
}

// A message under the recorder or after an action. A refusal is announced at once (role alert).
interface Message {
  readonly tone: 'info' | 'refuse';
  readonly text: string;
}

// A key the recorder has captured and the store has checked, waiting for Assign.
interface Pending {
  readonly text: string;
  readonly result: ChordCheck;
}

function messageFor(result: ChordCheck, keys: string, names: ReadonlyMap<string, string>): Message {
  const shown = displayKeys([keys], IS_MAC);
  if (result.kind === 'ok') {
    return { tone: 'info', text: t('shortcuts.msg.ready', { keys: shown }) };
  }
  if (result.kind === 'warn') {
    const reason =
      result.reason === 'letter'
        ? t('shortcuts.reason.letter')
        : t('shortcuts.reason.browserMayKeep');
    return { tone: 'info', text: t('shortcuts.msg.warn', { keys: shown, reason }) };
  }
  switch (result.reason) {
    case 'duplicate':
      return {
        tone: 'refuse',
        text: t('shortcuts.msg.duplicate', {
          keys: shown,
          name: names.get(result.otherId ?? '') ?? '',
        }),
      };
    case 'browser':
      return { tone: 'refuse', text: t('shortcuts.msg.browser') };
    case 'app':
      return { tone: 'refuse', text: t('shortcuts.msg.app') };
    case 'os':
      return { tone: 'refuse', text: t('shortcuts.msg.os') };
    default:
      return { tone: 'refuse', text: t('shortcuts.msg.invalid') };
  }
}

function ShortcutEditor({ registry, state }: { registry: Registry; state: CommandState }) {
  useShortcutBindings();
  const uid = useId();
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetRef = useRef<HTMLButtonElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // Set when Keep is pressed: the Reset all button comes back only after the confirmation unmounts,
  // so focus moves to it in an effect, once it is rendered again.
  const returnToResetRef = useRef(false);

  useEffect(() => {
    if (!confirmingReset && returnToResetRef.current) {
      returnToResetRef.current = false;
      resetRef.current?.focus();
    }
  }, [confirmingReset]);

  // The filter's autoFocus can be undone after mount: react-aria's Dialog focuses the dialog
  // element when nothing inside it has focus yet, and in a browser that lands after the input
  // was focused (the dialog is nested over Preferences). So the filter takes focus one frame
  // later. It does not take it back from a control the user has moved to inside this dialog.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const filter = filterRef.current;
      if (filter === null || document.activeElement === filter) return;
      const active = document.activeElement;
      const dialogEl = filter.closest('[role="dialog"]');
      const movedWithin =
        active !== null && active !== document.body && dialogEl?.contains(active) === true;
      const onDialogFrame = active === dialogEl;
      if (!movedWithin || onDialogFrame) filter.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // Every command's name, the palette's included. Only visible commands get a row, but a hidden
  // one still holds its keys for conflict checks (design section 4).
  const names = new Map<string, string>(registry.commands.map((def) => [def.id, t(def.labelId)]));
  names.set(PALETTE_SHORTCUT_ID, t('palette.title'));
  const rows = [
    ...registry.commands.filter((def) => isVisible(def, state)).map((def) => def.id),
    PALETTE_SHORTCUT_ID,
  ];
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter((id) => (names.get(id) ?? '').toLowerCase().includes(needle));
  const activeId = selectedId ?? rows[0] ?? PALETTE_SHORTCUT_ID;
  const activeName = names.get(activeId) ?? '';
  const activeKeys = effectiveKeys(activeId);

  // The first other command that holds one of these keys, or undefined.
  const holderOf = (id: string, keys: readonly string[]): string | undefined => {
    const mine = new Set(keys.map(canonicalChord));
    if (mine.size === 0) return undefined;
    for (const other of names.keys()) {
      if (other !== id && effectiveKeys(other).some((k) => mine.has(canonicalChord(k)))) {
        return other;
      }
    }
    return undefined;
  };

  const keysText = (keys: readonly string[]): string =>
    keys.length === 0 ? t('shortcuts.noKeys') : displayKeys(keys, IS_MAC);

  const statusOf = (id: string): string => {
    const holder = holderOf(id, effectiveKeys(id));
    if (holder !== undefined) {
      return t('shortcuts.status.conflict', { name: names.get(holder) ?? '' });
    }
    return userKeys(id) === undefined
      ? t('shortcuts.status.default')
      : t('shortcuts.status.changed');
  };

  const select = (id: string) => {
    setSelectedId(id);
    setPending(undefined);
    setMessage(undefined);
    setConfirmingReset(false);
  };

  const onCapture = (captured: RecordedChord) => {
    setConfirmingReset(false);
    if (captured.kind === 'os') {
      setPending(undefined);
      setMessage({ tone: 'refuse', text: t('shortcuts.msg.os') });
      return;
    }
    const result = check(activeId, captured.text);
    setPending({ text: captured.text, result });
    setMessage(messageFor(result, captured.text, names));
  };

  // Shows the outcome of an action and returns focus to the selected row, which stays in the table
  // when the Assign or Remove button is disabled by the change. A failed write still applies for
  // this page view, and the message says so.
  const finish = (text: string, saved: boolean) => {
    setPending(undefined);
    setMessage({ tone: 'info', text: saved ? text : `${text} ${t('shortcuts.saveFailed')}` });
    // The row is missing when the filter hides the selected command; the filter takes focus then.
    (rowRefs.current.get(activeId) ?? filterRef.current)?.focus();
  };

  const canAssign = pending !== undefined && pending.result.kind !== 'refuse';
  const doAssign = () => {
    if (pending === undefined || pending.result.kind === 'refuse') return;
    // Checked again now: another command may have taken the chord since it was recorded.
    const fresh = check(activeId, pending.text);
    if (fresh.kind === 'refuse') {
      setPending(undefined);
      setMessage(messageFor(fresh, pending.text, names));
      (rowRefs.current.get(activeId) ?? filterRef.current)?.focus();
      return;
    }
    const saved = assign(activeId, [pending.text]);
    finish(
      t('shortcuts.done.assigned', { name: activeName, keys: displayKeys([pending.text], IS_MAC) }),
      saved,
    );
  };
  const doRemove = () => {
    finish(t('shortcuts.done.removed', { name: activeName }), assign(activeId, []));
  };
  const doDefault = () => {
    finish(t('shortcuts.done.default', { name: activeName }), reset(activeId));
  };
  const doResetAll = () => {
    setConfirmingReset(false);
    finish(t('shortcuts.done.reset'), reset());
  };

  const messageId = `${uid}-message`;

  return (
    <div className="shortcut-editor">
      <label className="shortcut-filter-label" htmlFor={`${uid}-filter`}>
        {t('shortcuts.filter')}
      </label>
      <input
        ref={filterRef}
        id={`${uid}-filter`}
        type="search"
        className="shortcut-filter"
        autoFocus
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <p className="shortcut-count" aria-live="polite">
        {tp('shortcuts.count', shown.length)}
      </p>
      {shown.length === 0 ? <p className="palette-empty">{t('palette.empty')}</p> : null}

      <div className="shortcut-table-wrap">
        <table className="shortcut-table">
          <caption className="shortcut-caption">{t('shortcuts.table.caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('shortcuts.col.command')}</th>
              <th scope="col">{t('shortcuts.col.keys')}</th>
              <th scope="col">{t('shortcuts.col.status')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((id) => (
              <tr key={id}>
                <td>
                  <button
                    type="button"
                    className="shortcut-row-button"
                    aria-pressed={id === activeId}
                    ref={(el) => {
                      if (el) rowRefs.current.set(id, el);
                      else rowRefs.current.delete(id);
                    }}
                    onClick={() => select(id)}
                  >
                    {names.get(id)}
                  </button>
                </td>
                <td>
                  <kbd>{keysText(effectiveKeys(id))}</kbd>
                </td>
                <td>{statusOf(id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="shortcut-selected" aria-label={activeName}>
        <h3 className="palette-heading">{activeName}</h3>
        <p className="shortcut-current">
          {t('shortcuts.current')}: <kbd>{keysText(activeKeys)}</kbd>
        </p>
        <div className="shortcut-row">
          <KeyRecorder
            commandName={activeName}
            isMac={IS_MAC}
            describedBy={messageId}
            onCapture={onCapture}
          />
          {pending === undefined ? null : <kbd>{displayKeys([pending.text], IS_MAC)}</kbd>}
        </div>
        <div id={messageId} className="shortcut-messages">
          <p className="shortcut-message" aria-live="polite">
            {message?.tone === 'info' ? message.text : ''}
          </p>
          <p className="shortcut-message shortcut-refusal" role="alert">
            {message?.tone === 'refuse' ? message.text : ''}
          </p>
        </div>
        <div className="shortcut-row">
          <Button className="overlay-close" isDisabled={!canAssign} onPress={doAssign}>
            {t('shortcuts.assign')}
          </Button>
          <Button className="overlay-close" isDisabled={activeKeys.length === 0} onPress={doRemove}>
            {t('shortcuts.remove')}
          </Button>
          <Button
            className="overlay-close"
            isDisabled={userKeys(activeId) === undefined}
            onPress={doDefault}
          >
            {t('shortcuts.default')}
          </Button>
        </div>
      </section>

      <div className="shortcut-reset">
        {confirmingReset ? (
          <div className="shortcut-row" role="group">
            <p className="shortcut-message">{t('shortcuts.resetAll.confirm')}</p>
            <Button
              className="overlay-close"
              autoFocus
              onPress={() => {
                returnToResetRef.current = true;
                setConfirmingReset(false);
              }}
            >
              {t('shortcuts.resetAll.keep')}
            </Button>
            <Button className="overlay-close" onPress={doResetAll}>
              {t('shortcuts.resetAll.yes')}
            </Button>
          </div>
        ) : (
          <Button ref={resetRef} className="overlay-close" onPress={() => setConfirmingReset(true)}>
            {t('shortcuts.resetAll')}
          </Button>
        )}
      </div>
    </div>
  );
}
