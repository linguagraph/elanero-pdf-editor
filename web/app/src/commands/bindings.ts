// User-editable shortcuts on the web (W4.x, #330, design docs/web/design/W4.x-editable-shortcuts.md).
// A command's keys are the user's binding when it has one, else the web default (the override table,
// else the shared table). Only the user's changes are stored, in localStorage under one key, so a
// release that changes a default reaches every user who has not changed that command. Plain
// TypeScript with no React: the hook that re-renders components is in useShortcutBindings.ts.
import shortcutTable from '../../../src/generated/shortcuts.json';
import { WEB_SHORTCUT_OVERRIDES } from '../../../src/shortcuts.web';
import { canonicalChord, parseChord } from './chord';
import { sharedKeys } from './registry';

// The palette's own shortcut. It is in the shared table but is not a registry command.
const PALETTE_ID = 'command-palette';
export const BINDINGS_STORAGE_KEY = 'elanero.shortcuts';
const BINDINGS_VERSION = 1;

const OVERRIDES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(WEB_SHORTCUT_OVERRIDES),
);

// The ids a binding may name: the shared table's commands, the web overrides and the palette.
// Stored ids outside this set are dropped on load (the command was renamed or removed).
function isKnownId(id: string): boolean {
  return (
    id === PALETTE_ID ||
    OVERRIDES.has(id) ||
    Object.prototype.hasOwnProperty.call(shortcutTable.commands, id)
  );
}

function knownIds(): string[] {
  return [...new Set([PALETTE_ID, ...OVERRIDES.keys(), ...Object.keys(shortcutTable.commands)])];
}

// The web default for a command: the override when it has one, the shared table's keys otherwise.
export function defaultKeys(id: string): readonly string[] {
  return OVERRIDES.get(id) ?? sharedKeys(id);
}

// ---- Conflict rules (design section 5) -------------------------------------------------------

// The reasons a chord is refused or warned about. The dialog turns each into a message.
export type ChordReason =
  'invalid' | 'duplicate' | 'browser' | 'browserMayKeep' | 'app' | 'os' | 'letter';

export type ChordCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'warn'; readonly reason: ChordReason }
  | { readonly kind: 'refuse'; readonly reason: ChordReason; readonly otherId?: string };

// Keys the browser takes before the page sees them (W1.6 table and the additions in section 5).
const BROWSER_KEEPS: ReadonlySet<string> = new Set([
  'ctrl+w',
  'ctrl+f4',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+n',
  'ctrl+q',
  'ctrl+shift+n',
  'ctrl+shift+t',
  'ctrl+shift+i',
  'ctrl+shift+c',
  'ctrl+t',
  'ctrl+l',
  'ctrl+r',
  'f5',
  'f11',
  'f12',
  'ctrl+shift+j',
  'alt+f4',
  'alt+d',
  'alt+f',
]);

// Keys some browsers use for themselves (the second group of W1.6): allowed, with a warning.
const BROWSER_MAY_KEEP: ReadonlySet<string> = new Set([
  ...'0123456789'.split('').map((digit) => `ctrl+${digit}`),
  'ctrl++',
  'ctrl+=',
  'ctrl+-',
  'ctrl+e',
  'ctrl+k',
  'ctrl+d',
]);

// Keys Elanero needs for moving around and editing (WCAG 2.1.1, 2.1.2). Refused with no Ctrl or
// Alt; Shift alone does not make them free (Shift+Tab is the way back).
const APP_KEYS: ReadonlySet<string> = new Set([
  'tab',
  'escape',
  'enter',
  'space',
  'backspace',
  'delete',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'home',
  'end',
  'pageup',
  'pagedown',
  'f6',
  'f2',
]);
// Keys the Bookmarks panel uses (design section 5).
const APP_CHORDS: ReadonlySet<string> = new Set(['alt+shift+n']);
const ARROW_KEYS: ReadonlySet<string> = new Set([
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
]);

// Named keys a chord may use besides a letter, a digit or a punctuation character.
const NAMED_KEYS: ReadonlySet<string> = new Set([
  ...APP_KEYS,
  'insert',
  'printscreen',
  'contextmenu',
]);

function isValidKey(key: string): boolean {
  return key.length === 1 || NAMED_KEYS.has(key) || /^f([1-9]|1[0-2])$/.test(key);
}

// Why a chord is refused outright (not a duplicate): the browser's keys, the OS keys and Elanero's
// own keys. Undefined when the chord is allowed. Unparseable chords are refused as 'invalid'.
function refusalOf(text: string): ChordReason | undefined {
  const chord = parseChord(text);
  if (!isValidKey(chord.key)) return 'invalid';
  const canon = canonicalChord(text);
  if (BROWSER_KEEPS.has(canon)) return 'browser';
  // Alt+Tab (the window switcher) and Ctrl+Alt+Delete (the OS security screen).
  if ((chord.alt && chord.key === 'tab') || (chord.ctrl && chord.alt && chord.key === 'delete')) {
    return 'os';
  }
  if (APP_CHORDS.has(canon)) return 'app';
  if (!chord.ctrl && !chord.alt && APP_KEYS.has(chord.key)) return 'app';
  if (chord.alt && chord.shift && ARROW_KEYS.has(chord.key)) return 'app';
  return undefined;
}

// Checks a chord for command `id`: refuse-class first, then a duplicate, then warn-class. A
// duplicate counts every other command's effective keys, hidden ones included, so a capability
// switched on later cannot create a clash.
export function check(id: string, text: string): ChordCheck {
  const refusal = refusalOf(text);
  if (refusal !== undefined) return { kind: 'refuse', reason: refusal };
  const canon = canonicalChord(text);
  for (const other of knownIds()) {
    if (other === id) continue;
    if (effectiveKeys(other).some((keys) => canonicalChord(keys) === canon)) {
      return { kind: 'refuse', reason: 'duplicate', otherId: other };
    }
  }
  if (BROWSER_MAY_KEEP.has(canon)) return { kind: 'warn', reason: 'browserMayKeep' };
  const chord = parseChord(text);
  if (!chord.ctrl && !chord.alt && /^[a-z0-9]$/.test(chord.key)) {
    return { kind: 'warn', reason: 'letter' };
  }
  return { kind: 'ok' };
}

// Ctrl+O, Ctrl+S and Ctrl+P are always stopped on the web, bound or not, so the browser's own
// Open, Save and Print dialogs never open over the app (design section 5).
const ALWAYS_PREVENTED: ReadonlySet<string> = new Set(['o', 's', 'p']);

export interface PreventableEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function isAlwaysPrevented(event: PreventableEvent, isMac: boolean): boolean {
  const ctrlDown = isMac ? event.metaKey : event.ctrlKey;
  return (
    ctrlDown && !event.shiftKey && !event.altKey && ALWAYS_PREVENTED.has(event.key.toLowerCase())
  );
}

// ---- Store ----------------------------------------------------------------------------------

// The user's bindings: a command id to its keys. An empty list means the command has no key.
type Bindings = Readonly<Record<string, readonly string[]>>;

let cache: Bindings | undefined;
let version = 0;
const listeners = new Set<() => void>();

// A stored chord is applied only when it parses and passes the refusal rules (design section 5).
function isStorable(text: string): boolean {
  return refusalOf(text) === undefined;
}

// Reads the stored bindings. A missing key, corrupt JSON, an unknown version or a non-object gives
// no bindings, so every command keeps its default. Entries that fail a check are dropped.
function readStored(): Bindings {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(BINDINGS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as { version?: unknown; bindings?: unknown };
  if (record.version !== BINDINGS_VERSION) return {};
  if (typeof record.bindings !== 'object' || record.bindings === null) return {};
  const out: Record<string, readonly string[]> = {};
  for (const [id, value] of Object.entries(record.bindings)) {
    if (!isKnownId(id) || !Array.isArray(value)) continue;
    const keys = value.filter((text): text is string => typeof text === 'string');
    if (keys.every(isStorable)) out[id] = keys;
  }
  return out;
}

function current(): Bindings {
  cache ??= readStored();
  return cache;
}

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

// Writes the bindings; an empty set removes the key. Returns false when the browser refused the
// write (private window, quota). The change still applies for this page view.
function persist(next: Bindings): boolean {
  try {
    if (Object.keys(next).length === 0) {
      window.localStorage.removeItem(BINDINGS_STORAGE_KEY);
      return true;
    }
    window.localStorage.setItem(
      BINDINGS_STORAGE_KEY,
      JSON.stringify({ version: BINDINGS_VERSION, bindings: next }),
    );
    return true;
  } catch {
    return false;
  }
}

function commit(next: Bindings): boolean {
  cache = next;
  const saved = persist(next);
  emit();
  return saved;
}

// The keys the user set for a command, or undefined when the command keeps its default.
export function userKeys(id: string): readonly string[] | undefined {
  const bindings = current();
  return Object.hasOwn(bindings, id) ? bindings[id] : undefined;
}

// The keys a command is bound to on the web now: the user's keys, else the default.
export function effectiveKeys(id: string): readonly string[] {
  return userKeys(id) ?? defaultKeys(id);
}

// Sets a command's keys. A value equal to the default drops the user's entry, so only real changes
// are stored. An empty list removes the command's keys.
export function assign(id: string, keys: readonly string[]): boolean {
  const next: Record<string, readonly string[]> = { ...current() };
  const canonical = keys.map(canonicalChord).join('|');
  if (canonical === defaultKeys(id).map(canonicalChord).join('|')) {
    delete next[id];
  } else {
    next[id] = [...keys];
  }
  return commit(next);
}

// Restores one command's default keys, or every command's when no id is given.
export function reset(id?: string): boolean {
  if (id === undefined) return commit({});
  const next: Record<string, readonly string[]> = { ...current() };
  delete next[id];
  return commit(next);
}

// Calls the listener after each change, from this tab or another one. Returns the stop function.
export function subscribeBindings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// A number that changes with every change, for useSyncExternalStore.
export function bindingsVersion(): number {
  return version;
}

// Another tab's write reaches this tab here, so the stored value is read again and all open tabs
// agree. A null key means another tab cleared all its storage.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === BINDINGS_STORAGE_KEY || event.key === null) {
      cache = undefined;
      emit();
    }
  });
}
