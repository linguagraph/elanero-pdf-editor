// Shortcut bindings for the web app (W1.6 section 9, W4.3b). A command's keys are the web override
// (web/src/shortcuts.web.ts) when it has one, and the shared table's keys otherwise. This module
// parses the key strings, matches keyboard events against them and formats them for display. It
// does no PDF work and calls no engine.
import { WEB_SHORTCUT_OVERRIDES } from '../../../src/shortcuts.web';
import { isVisible } from './run';
import { sharedKeys, type CommandDef, type CommandState, type Registry } from './registry';

// The palette's own shortcut. It is in the shared table but is not a registry command: it opens the
// palette rather than running a command.
export const PALETTE_SHORTCUT_ID = 'command-palette';

const OVERRIDES: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries(WEB_SHORTCUT_OVERRIDES),
);

// The keys a command is bound to on the web: the override when it has one (an empty override
// means no shortcut), the shared table's keys otherwise.
export function effectiveKeys(id: string): readonly string[] {
  return OVERRIDES.get(id) ?? sharedKeys(id);
}

// One parsed key string, such as "Ctrl+Shift+P". `key` is lower case and names a key the way
// KeyboardEvent.key does (letters, digits, "arrowleft", "pagedown", "tab", "f4", "=", "-").
export interface Chord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

// The table's names for keys that KeyboardEvent.key spells differently.
const KEY_NAMES: Readonly<Record<string, string>> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  pgup: 'pageup',
  pgdn: 'pagedown',
  esc: 'escape',
};

export function parseChord(text: string): Chord {
  // "Ctrl++" is Ctrl with the plus key, so the key is "+" and the modifiers are the text before it.
  const isPlusKey = text.endsWith('++');
  const parts = (isPlusKey ? text.slice(0, -2) : text).split('+');
  const name = isPlusKey ? '+' : (parts.pop() ?? '');
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  const key = KEY_NAMES[name.toLowerCase()] ?? name.toLowerCase();
  return {
    ctrl: modifiers.has('ctrl'),
    shift: modifiers.has('shift'),
    alt: modifiers.has('alt'),
    key,
  };
}

// The part of the event a chord is matched against. A type of its own keeps the matcher testable
// without a browser.
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

// On macOS the table's Ctrl is the Command key, as Qt maps it on the desktop.
export function matchesChord(event: KeyEventLike, chord: Chord, isMac: boolean): boolean {
  const ctrlDown = isMac ? event.metaKey : event.ctrlKey;
  if (ctrlDown !== chord.ctrl) return false;
  // The other platform's modifier is never part of a web chord: Meta on Windows and Linux, and the
  // Control key on macOS (where Control+H is not Cmd+H and must not run the Hand tool).
  if (isMac ? event.ctrlKey : event.metaKey) return false;
  if (event.shiftKey !== chord.shift || event.altKey !== chord.alt) return false;
  if (event.key.toLowerCase() === chord.key) return true;
  // With Alt (or Shift) on some platforms the key value changes, so a letter or digit is also
  // matched by its physical key code.
  if (/^[a-z0-9]$/.test(chord.key)) {
    return event.code === `Key${chord.key.toUpperCase()}` || event.code === `Digit${chord.key}`;
  }
  return false;
}

// The command a keyboard event asks for, or undefined. The palette's id is checked first. A
// visible command with a binding matches; a disabled command still matches, and the caller runs it
// through runCommand, which refuses it.
export function commandForEvent(
  event: KeyEventLike,
  registry: Registry,
  state: CommandState,
  isMac: boolean,
): string | undefined {
  const matches = (id: string): boolean =>
    effectiveKeys(id).some((text) => matchesChord(event, parseChord(text), isMac));
  if (matches(PALETTE_SHORTCUT_ID)) return PALETTE_SHORTCUT_ID;
  const def = registry.commands.find(
    (command: CommandDef) => isVisible(command, state) && matches(command.id),
  );
  return def?.id;
}

// True on macOS, from the platform string (navigator.platform).
export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

// A binding as the user reads it: Ctrl becomes Cmd on macOS.
export function displayKeys(keys: readonly string[], isMac: boolean): string {
  return keys.map((text) => (isMac ? text.replace(/^Ctrl\+/, 'Cmd+') : text)).join(', ');
}

// The keys a command is bound to on the web, as the user reads them, or undefined when it has none.
// The ribbon's tooltip and description use this, so they show the key the web binds.
export function shortcutLabel(id: string, isMac: boolean): string | undefined {
  const keys = effectiveKeys(id);
  return keys.length === 0 ? undefined : displayKeys(keys, isMac);
}
