// The lookup and interpolation for the message catalogue (W1.6 section 11). No i18n library: a
// lookup in the chosen catalogue, then in English, and `{name}` placeholders filled from params.
// Values are text, never HTML, so nothing is escaped here (the UI renders them as text nodes).
//
// `t()` reads text keys. `tp()` reads plural keys: it picks the form for the count with the plural
// rules of the language the form came from, and fills `{count}` with the count formatted for the
// active locale. Plural rules and number formats are cached per locale.
import { EN, type AnyMessageId, type MessageId, type PluralId } from './en';

export type Params = Readonly<Record<string, string | number>>;

export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

// One form per plural category. `other` is required; a missing category falls back to `other`.
export type Plural = Readonly<Partial<Record<PluralCategory, string>>> & { readonly other: string };

export type Entry = string | Plural;

// A catalogue in another language. It may omit keys; the missing ones fall back to English.
export type Catalogue = Partial<Record<AnyMessageId, Entry>>;

export interface Translator {
  t: (id: MessageId, params?: Params) => string;
  tp: (id: PluralId, count: number, params?: Params) => string;
}

// The active state: the language the UI shows and its catalogue. Only English exists for now, so
// the default is English with no catalogue; the loader sets the real one at start-up (D7).
let active: { locale: string; catalogue: Catalogue } = { locale: 'en', catalogue: {} };

export function getLocale(): string {
  return active.locale;
}

export function setLocale(locale: string, catalogue: Catalogue): void {
  active = { locale, catalogue };
}

const pluralRulesCache = new Map<string, Intl.PluralRules>();
const countFormatCache = new Map<string, Intl.NumberFormat>();

function pluralRulesFor(locale: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

function countFormatFor(locale: string): Intl.NumberFormat {
  let format = countFormatCache.get(locale);
  if (format === undefined) {
    format = new Intl.NumberFormat(locale);
    countFormatCache.set(locale, format);
  }
  return format;
}

// Replaces each `{name}` that has a param. A placeholder with no param is left as written, so a
// missing value shows up in review instead of silently disappearing.
function interpolate(template: string, params: Params | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

// `catalogue` and `locale` default to the active state, read at each call, so the app's `t` and
// `tp` follow `setLocale`. Tests and the loader pass them explicitly.
export function createTranslator(catalogue?: Catalogue, locale?: string): Translator {
  const currentCatalogue = (): Catalogue => catalogue ?? active.catalogue;
  const currentLocale = (): string => locale ?? active.locale;
  return {
    t: (id, params) => {
      const own = currentCatalogue()[id];
      return interpolate(typeof own === 'string' ? own : EN[id], params);
    },
    tp: (id, count, params) => {
      if (import.meta.env.DEV && params !== undefined && 'count' in params) {
        throw new Error(`tp('${id}') takes the count as its second argument, not in params`);
      }
      // A form from the active catalogue uses that language's rules. The English fallback uses
      // English rules, so a Polish `few` never looks up an English object that lacks it.
      const own = currentCatalogue()[id];
      const form: Plural = typeof own === 'object' ? own : EN[id];
      const rulesLocale = typeof own === 'object' ? currentLocale() : 'en';
      const category = pluralRulesFor(rulesLocale).select(count) as PluralCategory;
      const template = form[category] ?? form.other;
      const countText = countFormatFor(currentLocale()).format(count);
      return interpolate(template, { ...params, count: countText });
    },
  };
}

// The app's translator. It reads the active locale and catalogue on each call.
export const { t, tp } = createTranslator();
