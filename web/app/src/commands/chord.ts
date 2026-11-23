// Parsing of the portable key strings ("Ctrl+Shift+P", "Ctrl++", "Alt+PgDn") that the shared table
// and the stored user bindings use. Pure: no browser, no engine. Split out of shortcuts.ts so the
// binding store can parse chords without importing the matcher, which needs the store.

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

// The comparison form of a key string: modifiers in the fixed order Ctrl, Alt, Shift, then the
// normalised key. "Shift+Ctrl+P", "ctrl+shift+p" and "Ctrl+Shift+P" are one chord, and "PgDn" is
// "PageDown". Two bindings clash when their canonical forms are equal.
export function canonicalChord(text: string): string {
  const chord = parseChord(text);
  return [
    chord.ctrl ? 'ctrl+' : '',
    chord.alt ? 'alt+' : '',
    chord.shift ? 'shift+' : '',
    chord.key,
  ].join('');
}
