// The lookup and interpolation for the message catalogue (W1.6 section 11). No i18n library: a
// lookup in the chosen catalogue, then in English, and `{name}` placeholders filled from params.
// Values are text, never HTML, so nothing is escaped here (the UI renders them as text nodes).
import { EN, type MessageId } from './en';

export type Params = Readonly<Record<string, string | number>>;

// A catalogue in another language. It may omit keys; the missing ones fall back to English.
export type Catalogue = Partial<Record<MessageId, string>>;

// Replaces each `{name}` that has a param. A placeholder with no param is left as written, so a
// missing value shows up in review instead of silently disappearing.
function interpolate(template: string, params: Params | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export function createTranslator(
  catalogue: Catalogue = {},
): (id: MessageId, params?: Params) => string {
  return (id, params) => interpolate(catalogue[id] ?? EN[id], params);
}

// The app's translator. Only English exists for now, so this is the English catalogue.
export const t = createTranslator();
