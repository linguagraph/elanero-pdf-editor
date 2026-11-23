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

// The part of a keydown the key recorder reads. A type of its own keeps the function testable
// without a browser.
export interface RecordedKeyEvent {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

// The outcome of one recorded keydown: a chord in the portable form, or the platform's other
// modifier (Meta on Windows and Linux, Control on macOS), which the recorder does not accept in v1.
export type RecordedChord =
  { readonly kind: 'chord'; readonly text: string } | { readonly kind: 'os' };

// Keys that only modify or lock other keys. Pressed alone they are ignored, so the recorder keeps
// waiting. The lock keys and the Super, Hyper and Fn family are included, so they are not refused.
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'OS',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Super',
  'Hyper',
  'Symbol',
  'SymbolLock',
]);

// KeyboardEvent.key names that the table spells another way (the inverse of KEY_NAMES above).
const RECORDED_NAMES: Readonly<Record<string, string>> = {
  ' ': 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Escape: 'Esc',
};

// The key string a keydown stands for, or undefined for a modifier key pressed alone (the recorder
// keeps waiting). Letters and digits come from the physical key, so Alt on macOS, which changes
// event.key, still records "A" and "1". Ctrl means Cmd on macOS, as in the table.
export function chordFromKeyEvent(
  event: RecordedKeyEvent,
  isMac: boolean,
): RecordedChord | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined;
  if (isMac ? event.ctrlKey : event.metaKey) return { kind: 'os' };
  const letter = /^Key([A-Z])$/.exec(event.code);
  const digit = /^Digit([0-9])$/.exec(event.code);
  const name = letter?.[1] ?? digit?.[1] ?? RECORDED_NAMES[event.key] ?? event.key;
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(name);
  return { kind: 'chord', text: parts.join('+') };
}
