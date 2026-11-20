// The per-language catalogues (W4.7 S4). English is the source and stays in `en.ts`; every other
// language is one flat JSON file, `locales/<lang>.json`, loaded lazily so a language costs nothing
// until it is chosen. A file is validated before use: whatever is wrong with an entry is dropped
// and reported, so the rest of the file still applies and any key it lacks falls back to English.
import { EN, type AnyMessageId } from './en';
import { setLocale, type Catalogue, type Entry, type Plural, type PluralCategory } from './t';

// Each `locales/*.json` is its own chunk, served from the app's own origin (the CSP allows 'self').
// Exported so tests can check the glob against the files on disk.
export type LoaderMap = Readonly<Record<string, () => Promise<unknown>>>;
export const LOCALE_LOADERS: LoaderMap = import.meta.glob<Record<string, unknown>>(
  './locales/*.json',
  { import: 'default' },
);

// Right-to-left scripts, used when the browser cannot say the text direction (Intl.Locale
// getTextInfo is missing in Firefox).
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

const PLURAL_CATEGORY_NAMES: readonly string[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

function isPluralCategory(name: string): name is PluralCategory {
  return PLURAL_CATEGORY_NAMES.includes(name);
}

function isEnglishKey(key: string): key is AnyMessageId {
  return Object.hasOwn(EN, key);
}

function placeholdersOf(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1] ?? ''));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

// The categories the language uses (Polish: one, few, many, other). An invalid tag gets the
// English rules, so one bad tag cannot stop the rest of the file from loading.
function categoriesOf(lang: string): readonly string[] {
  try {
    return new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
  } catch {
    return new Intl.PluralRules('en').resolvedOptions().pluralCategories;
  }
}

// The checks every form shares: text, not empty, no markup. Returns the reason, or undefined.
function checkFormText(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'expected text';
  if (value.trim() === '') return 'empty text';
  if (/[<>]/.test(value)) return 'markup in text';
  return undefined;
}

// A text entry must use exactly the placeholders of its English text.
function checkText(value: unknown, english: string): string | undefined {
  const problem = checkFormText(value);
  if (problem !== undefined) return problem;
  if (!sameSet(placeholdersOf(value as string), placeholdersOf(english))) {
    return 'placeholders differ from English';
  }
  return undefined;
}

// A plural form may leave out {count}, but may not add a placeholder that English does not have.
function checkPluralForm(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  const problem = checkFormText(value);
  if (problem !== undefined) return problem;
  for (const placeholder of placeholdersOf(value as string)) {
    if (!allowed.has(placeholder)) return `placeholder {${placeholder}} is not in English`;
  }
  return undefined;
}

// The outcome for one entry: the checked entry, or the reason it was dropped. A result object,
// because a text entry is itself a string and cannot tell the two apart.
type Checked = { readonly entry: Entry } | { readonly problem: string };

function checkEntry(value: unknown, english: Entry, categories: readonly string[]): Checked {
  if (typeof english === 'string') {
    const problem = checkText(value, english);
    return problem === undefined ? { entry: value as string } : { problem };
  }
  const plural = checkPlural(value, english, categories);
  return typeof plural === 'string' ? { problem: plural } : { entry: plural };
}

// A plural entry: its forms must be known categories of this language, with an `other` form.
function checkPlural(
  value: unknown,
  english: Plural,
  categories: readonly string[],
): Plural | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'expected plural forms, not text';
  }
  const englishPlaceholders = new Set<string>();
  for (const form of Object.values(english)) {
    if (typeof form === 'string') placeholdersOf(form).forEach((p) => englishPlaceholders.add(p));
  }
  const forms: Partial<Record<PluralCategory, string>> = {};
  for (const [name, text] of Object.entries(value)) {
    if (!isPluralCategory(name) || !categories.includes(name)) {
      return `plural category "${name}" is not used by this language`;
    }
    const problem = checkPluralForm(text, englishPlaceholders);
    if (problem !== undefined) return problem;
    forms[name] = text as string;
  }
  const other = forms.other;
  if (other === undefined) return 'plural without an "other" form';
  if (!sameSet(placeholdersOf(other), placeholdersOf(english.other))) {
    return 'the "other" form has different placeholders from English';
  }
  const plural: Plural = { ...forms, other };
  return plural;
}

export interface Validated {
  readonly catalogue: Catalogue;
  // One line per dropped entry or file-level fault, for the console.
  readonly problems: readonly string[];
}

// Checks a parsed locale file against English and the language's plural rules. Each entry is kept
// or dropped on its own; a dropped entry falls back to English.
export function validateCatalogue(raw: unknown, lang: string): Validated {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { catalogue: {}, problems: [`${lang}: the file is not a JSON object`] };
  }
  const categories = categoriesOf(lang);
  const catalogue: Partial<Record<AnyMessageId, Entry>> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!isEnglishKey(key)) {
      problems.push(`${key}: unknown key, dropped`);
      continue;
    }
    const checked = checkEntry(value, EN[key], categories);
    if ('problem' in checked) {
      problems.push(`${key}: ${checked.problem}, dropped`);
    } else {
      catalogue[key] = checked.entry;
    }
  }
  return { catalogue, problems };
}

// How long start-up waits for a language file before using English. A stalled fetch must not
// leave the page blank, so the wait is bounded.
export const LOCALE_LOAD_TIMEOUT_MS = 3000;

// The catalogue for a language. English, a language with no file, a file that fails to load, and
// a file that takes longer than the timeout all give `{}`, so start-up never waits on a
// translation that is missing, broken or stalled.
export async function loadCatalogue(
  lang: string,
  loaders: LoaderMap = LOCALE_LOADERS,
  timeoutMs: number = LOCALE_LOAD_TIMEOUT_MS,
): Promise<Catalogue> {
  if (lang === 'en') return {};
  const load = loaders[`./locales/${lang}.json`];
  if (load === undefined) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[i18n] ${lang} did not load within ${timeoutMs} ms; using English`);
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([load(), timedOut]);
    if (raw === undefined) return {};
    const { catalogue, problems } = validateCatalogue(raw, lang);
    for (const problem of problems) console.warn(`[i18n] ${problem}`);
    return catalogue;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[i18n] could not load ${lang}: ${reason}`);
    return {};
  } finally {
    clearTimeout(timer);
  }
}

// Start-up: load the chosen language, apply it, then mount. If anything in that fails, the app
// still mounts, in English, so the page never stays blank.
export function startWithLocale(
  lang: string,
  mount: () => void,
  load: (lang: string) => Promise<Catalogue> = (l) => loadCatalogue(l),
): Promise<void> {
  return load(lang)
    .then((catalogue) => {
      applyLocale(lang, catalogue);
      mount();
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[i18n] start-up failed for ${lang}, using English: ${reason}`);
      applyLocale('en', {});
      mount();
    });
}

export function isRightToLeft(lang: string): boolean {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(lang);
  } catch {
    return false;
  }
  const info = (locale as { getTextInfo?: () => { direction?: string } }).getTextInfo?.();
  if (info?.direction === 'rtl' || info?.direction === 'ltr') return info.direction === 'rtl';
  return RTL_LANGUAGES.has(locale.language);
}

// Makes a catalogue the active one and sets the page's language and direction to match.
export function applyLocale(lang: string, catalogue: Catalogue): void {
  setLocale(lang, catalogue);
  const root = document.documentElement;
  root.lang = lang;
  root.dir = isRightToLeft(lang) ? 'rtl' : 'ltr';
}
