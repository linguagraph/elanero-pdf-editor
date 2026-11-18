// The local preferences store (W1.1 section 6, W1.6 section 9, W4.5). Preferences live in
// localStorage and never hold a secret: a key that looks like a password, token or key is refused
// at the storage boundary, so no caller can store one by mistake. Every access is wrapped in
// try/catch, because localStorage can be missing or throw (private windows, blocked site data).
// Then the store answers with the defaults and remembers nothing for this page view.
import { readStoredTheme, setTheme, type ThemeChoice } from '../theme/theme';

export const LANGUAGE_CHOICES = ['en'] as const;
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

// The desktop's zoom choices (PreferencesDialog "Default zoom").
export const ZOOM_CHOICES = ['fitWidth', 'fitPage', 'actual'] as const;
export type ZoomChoice = (typeof ZOOM_CHOICES)[number];

export const AUTHOR_NAME_MAX_LENGTH = 64;

export interface Preferences {
  readonly theme: ThemeChoice;
  readonly language: LanguageChoice;
  readonly authorName: string;
  readonly defaultZoom: ZoomChoice;
  readonly reduceMotion: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  language: 'en',
  authorName: '',
  defaultZoom: 'fitWidth',
  reduceMotion: false,
};

// The non-theme preferences are one JSON object. The theme keeps its own key (theme.ts), because
// the head script reads it before the app starts.
export const PREFS_STORAGE_KEY = 'elanero.prefs';

// Words that mark a storage key as holding a secret (W1.1 section 6). A key is split into words at
// punctuation and at camel-case boundaries, so `translation.apiKey` has the word `key`. Matching
// whole words keeps harmless names such as `keyboardShortcuts` or `pinned` allowed.
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwords',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'tokens',
  'key',
  'keys',
  'pin',
  'credential',
  'credentials',
]);

export function isSecretKey(key: string): boolean {
  return key
    .split(/[^A-Za-z]+|(?=[A-Z][a-z])/)
    .some((word) => SECRET_WORDS.has(word.toLowerCase()));
}

// Writes one raw value. Returns false when the key is a secret (refused, nothing written) or the
// browser refused the write; a false return never throws.
export function writeStoredValue(key: string, value: string): boolean {
  if (isSecretKey(key)) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readRecord(): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Corrupt JSON or a throwing localStorage: every field falls back to its default.
    return {};
  }
}

function pickChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && (choices as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

// Trims the name and cuts it to the limit; a non-string gives the empty name.
export function cleanAuthorName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, AUTHOR_NAME_MAX_LENGTH) : '';
}

export function readPreferences(): Preferences {
  const record = readRecord();
  return {
    theme: readStoredTheme(),
    language: pickChoice(record.language, LANGUAGE_CHOICES, DEFAULT_PREFERENCES.language),
    authorName: cleanAuthorName(record.authorName),
    defaultZoom: pickChoice(record.defaultZoom, ZOOM_CHOICES, DEFAULT_PREFERENCES.defaultZoom),
    reduceMotion:
      typeof record.reduceMotion === 'boolean'
        ? record.reduceMotion
        : DEFAULT_PREFERENCES.reduceMotion,
  };
}

// Saves every preference. The theme goes through the theme module, so it is applied to the page
// as well. Returns false when the browser would not keep the values; the theme still applies.
export function writePreferences(prefs: Preferences): boolean {
  const record = {
    language: pickChoice(prefs.language, LANGUAGE_CHOICES, DEFAULT_PREFERENCES.language),
    authorName: cleanAuthorName(prefs.authorName),
    defaultZoom: pickChoice(prefs.defaultZoom, ZOOM_CHOICES, DEFAULT_PREFERENCES.defaultZoom),
    reduceMotion: prefs.reduceMotion,
  };
  setTheme(prefs.theme);
  return writeStoredValue(PREFS_STORAGE_KEY, JSON.stringify(record));
}
