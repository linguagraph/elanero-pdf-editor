// The local preferences store (W1.1 section 6, W1.6 section 9, W4.5). Preferences live in
// localStorage and never hold a secret: a key that looks like a password, token or key is refused
// at the storage boundary, so no caller can store one by mistake. Every access is wrapped in
// try/catch, because localStorage can be missing or throw (private windows, blocked site data).
// Then the store answers with the defaults and remembers nothing for this page view.
import { ACCENT_PRESETS, DEFAULT_ACCENT_ID, type AccentId } from '../theme/tokens';
import { readStoredTheme, setTheme, type ThemeChoice } from '../theme/theme';

export const LANGUAGE_CHOICES = ['en'] as const;
export type LanguageChoice = (typeof LANGUAGE_CHOICES)[number];

// The desktop's zoom choices (PreferencesDialog "Default zoom").
export const ZOOM_CHOICES = ['fitWidth', 'fitPage', 'actual'] as const;
export type ZoomChoice = (typeof ZOOM_CHOICES)[number];

// The default page layout (W4.5 S2). The single-page layout is W5.1a and is not offered until it
// exists, so it is not a choice here.
export const PAGE_LAYOUT_CHOICES = ['continuous', 'single', 'twoPage', 'twoPageCover'] as const;
export type PageLayoutChoice = (typeof PAGE_LAYOUT_CHOICES)[number];

export const AUTHOR_NAME_MAX_LENGTH = 64;

// Translation (W6.6): the web offers one service, MyMemory, with no settings. The consent record
// sits with the other preferences; nothing about translation is secret.
export const TRANSLATION_SERVICE = 'mymemory';
const LANGUAGE_CODE_MAX_LENGTH = 16;
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

// What the user agreed to: the service, the notice's version and the date (W6.6 section 7).
export interface TranslationConsent {
  readonly service: string;
  readonly version: number;
  readonly at: string;
}

// The redaction mark style (W4.5 S3): the desktop's MarkStyle defaults (black box, white text, no
// overlay text). Each new mark takes the style at the time it is made; marks already made keep it.
export const OVERLAY_TEXT_MAX_LENGTH = 64;
export const REDACTION_FILL_DEFAULT = '#000000';
export const REDACTION_TEXT_COLOR_DEFAULT = '#ffffff';

export interface Preferences {
  readonly theme: ThemeChoice;
  readonly language: LanguageChoice;
  readonly authorName: string;
  readonly defaultZoom: ZoomChoice;
  readonly reduceMotion: boolean;
  // Night reading inverts the pages in the document view (a view setting, W1.6; not a theme).
  readonly nightReading: boolean;
  readonly pageLayout: PageLayoutChoice;
  // The ribbon's own choices (W1.6 section 8): compact shows icons only, collapsed shows the tab
  // row only. They apply on top of the width's form, and survive a restart.
  readonly ribbonCompact: boolean;
  readonly ribbonCollapsed: boolean;
  // The redaction mark style (W4.5 S3): #rrggbb colours and the text drawn over a mark.
  readonly redactionFill: string;
  readonly redactionOverlayText: string;
  readonly redactionTextColor: string;
  // The accent colour preset (W4.5 S4); Blue is the default and the web's own dark blue.
  readonly accent: AccentId;
  // Translation (W6.6 section 5): on only after the consent notice, the default target language
  // ('' is the app's language), the last From language ('' before any choice) and the record.
  readonly translationEnabled: boolean;
  readonly translationTarget: string;
  readonly translationLastSource: string;
  readonly translationConsent: TranslationConsent | null;
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  language: 'en',
  authorName: '',
  defaultZoom: 'fitWidth',
  reduceMotion: false,
  nightReading: false,
  pageLayout: 'continuous',
  ribbonCompact: false,
  ribbonCollapsed: false,
  redactionFill: REDACTION_FILL_DEFAULT,
  redactionOverlayText: '',
  redactionTextColor: REDACTION_TEXT_COLOR_DEFAULT,
  accent: DEFAULT_ACCENT_ID,
  translationEnabled: false,
  translationTarget: '',
  translationLastSource: '',
  translationConsent: null,
};

// The non-theme preferences are one JSON object. The theme keeps its own key (theme.ts), because
// the head script reads it before the app starts.
export const PREFS_STORAGE_KEY = 'elanero.prefs';

// Dispatched on the window after the preferences are written, so an open view can apply a changed
// default (the same tab only: other tabs read the stored value when they next look).
export const PREFERENCES_CHANGED_EVENT = 'elanero:preferences-changed';

// Calls the listener after each write; returns the function that stops listening.
export function onPreferencesChanged(listener: () => void): () => void {
  window.addEventListener(PREFERENCES_CHANGED_EVENT, listener);
  return () => window.removeEventListener(PREFERENCES_CHANGED_EVENT, listener);
}

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

// A #rrggbb colour in lower case; anything else (a short form, a name, a stray character) gives the
// fallback. The colour input always sends this form, so the check is a guard, not a parser.
export function cleanHexColour(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const folded = value.toLowerCase();
  return /^#[0-9a-f]{6}$/.test(folded) ? folded : fallback;
}

// The text drawn over a redaction mark: control characters are dropped, the ends trimmed, and the
// result cut to the limit. A non-string gives the empty text (no overlay).
export function cleanOverlayText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const printable = Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
  return printable.trim().slice(0, OVERLAY_TEXT_MAX_LENGTH);
}

// A language code as MyMemory and the app write it ("en", "pt-BR"); anything else is the empty code.
export function cleanLanguageCode(value: unknown): string {
  return typeof value === 'string' &&
    value.length <= LANGUAGE_CODE_MAX_LENGTH &&
    LANGUAGE_CODE_PATTERN.test(value)
    ? value
    : '';
}

// The stored record, or null when it is missing or not one this build wrote.
export function cleanConsent(value: unknown): TranslationConsent | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.service !== TRANSLATION_SERVICE) return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version)) return null;
  if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) return null;
  return { service: TRANSLATION_SERVICE, version: record.version, at: record.at.slice(0, 40) };
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
    nightReading:
      typeof record.nightReading === 'boolean'
        ? record.nightReading
        : DEFAULT_PREFERENCES.nightReading,
    pageLayout: pickChoice(record.pageLayout, PAGE_LAYOUT_CHOICES, DEFAULT_PREFERENCES.pageLayout),
    ribbonCompact:
      typeof record.ribbonCompact === 'boolean'
        ? record.ribbonCompact
        : DEFAULT_PREFERENCES.ribbonCompact,
    ribbonCollapsed:
      typeof record.ribbonCollapsed === 'boolean'
        ? record.ribbonCollapsed
        : DEFAULT_PREFERENCES.ribbonCollapsed,
    redactionFill: cleanHexColour(record.redactionFill, DEFAULT_PREFERENCES.redactionFill),
    redactionOverlayText: cleanOverlayText(record.redactionOverlayText),
    redactionTextColor: cleanHexColour(
      record.redactionTextColor,
      DEFAULT_PREFERENCES.redactionTextColor,
    ),
    accent: pickChoice(record.accent, ACCENT_PRESETS, DEFAULT_PREFERENCES.accent),
    translationEnabled:
      typeof record.translationEnabled === 'boolean'
        ? record.translationEnabled
        : DEFAULT_PREFERENCES.translationEnabled,
    translationTarget: cleanLanguageCode(record.translationTarget),
    translationLastSource: cleanLanguageCode(record.translationLastSource),
    translationConsent: cleanConsent(record.translationConsent),
  };
}

// Reads one raw value, or null when the key is missing or the browser refuses the read. Never throws.
export function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

// Saves every preference. The theme goes through the theme module, so it is applied to the page
// as well. Returns false when the browser would not keep the values; the theme still applies.
export function writePreferences(prefs: Preferences): boolean {
  const record = {
    language: pickChoice(prefs.language, LANGUAGE_CHOICES, DEFAULT_PREFERENCES.language),
    authorName: cleanAuthorName(prefs.authorName),
    defaultZoom: pickChoice(prefs.defaultZoom, ZOOM_CHOICES, DEFAULT_PREFERENCES.defaultZoom),
    reduceMotion: prefs.reduceMotion,
    nightReading: prefs.nightReading,
    pageLayout: pickChoice(prefs.pageLayout, PAGE_LAYOUT_CHOICES, DEFAULT_PREFERENCES.pageLayout),
    ribbonCompact: prefs.ribbonCompact,
    ribbonCollapsed: prefs.ribbonCollapsed,
    redactionFill: cleanHexColour(prefs.redactionFill, DEFAULT_PREFERENCES.redactionFill),
    redactionOverlayText: cleanOverlayText(prefs.redactionOverlayText),
    redactionTextColor: cleanHexColour(
      prefs.redactionTextColor,
      DEFAULT_PREFERENCES.redactionTextColor,
    ),
    accent: pickChoice(prefs.accent, ACCENT_PRESETS, DEFAULT_PREFERENCES.accent),
    translationEnabled: prefs.translationEnabled,
    translationTarget: cleanLanguageCode(prefs.translationTarget),
    translationLastSource: cleanLanguageCode(prefs.translationLastSource),
    translationConsent: cleanConsent(prefs.translationConsent),
  };
  setTheme(prefs.theme);
  const saved = writeStoredValue(PREFS_STORAGE_KEY, JSON.stringify(record));
  // Only a write that was kept changes what the view reads, so only then is the change announced.
  if (saved) window.dispatchEvent(new Event(PREFERENCES_CHANGED_EVENT));
  return saved;
}
