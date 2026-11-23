// Shortcut bindings for the web app (W1.6 section 9, W4.3b). A command's keys are the web override
// (web/src/shortcuts.web.ts) when it has one, and the shared table's keys otherwise. This module
// parses the key strings, matches keyboard events against them and formats them for display. It
// does no PDF work and calls no engine.
import { effectiveKeys, userKeys } from './bindings';
import { type Chord, parseChord } from './chord';
import { isVisible } from './run';
import { type CommandDef, type CommandState, type Registry } from './registry';

export { type Chord, parseChord } from './chord';

// The palette's own shortcut. It is in the shared table but is not a registry command: it opens the
// palette rather than running a command.
export const PALETTE_SHORTCUT_ID = 'command-palette';

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
  const matches = (keys: readonly string[]): boolean =>
    keys.some((text) => matchesChord(event, parseChord(text), isMac));
  if (matches(effectiveKeys(PALETTE_SHORTCUT_ID))) return PALETTE_SHORTCUT_ID;
  const visible = registry.commands.filter((command: CommandDef) => isVisible(command, state));
  // A user binding wins over another command's default (design section 5): the user-bound commands
  // are tried first, then the rest. Among equal sources registry order decides.
  const userBound = visible.find(
    (command) => userKeys(command.id) !== undefined && matches(effectiveKeys(command.id)),
  );
  if (userBound) return userBound.id;
  return visible.find((command) => matches(effectiveKeys(command.id)))?.id;
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
