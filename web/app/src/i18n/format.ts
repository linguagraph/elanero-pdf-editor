// Numbers, dates and sizes formatted for the active locale (W4.7). Each `Intl` object is cached per
// locale, since formatting runs on every render. The active locale comes from `t.ts`, so these
// follow `setLocale`.
import { getLocale } from './t';

const MEBIBYTE = 1024 * 1024;
const DEFAULT_DATE: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

const numberCache = new Map<string, Intl.NumberFormat>();
const dateCache = new Map<string, Intl.DateTimeFormat>();
const megabyteCache = new Map<string, Intl.NumberFormat>();

function cached<T>(cache: Map<string, T>, locale: string, make: () => T): T {
  let value = cache.get(locale);
  if (value === undefined) {
    value = make();
    cache.set(locale, value);
  }
  return value;
}

// A count or other whole number, with the locale's grouping (1234 is "1,234" in English).
export function formatNumber(value: number): string {
  const locale = getLocale();
  return cached(numberCache, locale, () => new Intl.NumberFormat(locale)).format(value);
}

// A date and time in the locale's own format. The default is the medium date and short time.
export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE,
): string {
  const locale = getLocale();
  const date = value instanceof Date ? value : new Date(value);
  if (options === DEFAULT_DATE) {
    return cached(dateCache, locale, () => new Intl.DateTimeFormat(locale, options)).format(date);
  }
  return new Intl.DateTimeFormat(locale, options).format(date);
}

// A size in bytes as megabytes (MiB, as in the desktop app), e.g. "50 MB" or "2.5 MB".
export function formatMegabytes(bytes: number): string {
  const locale = getLocale();
  const format = cached(
    megabyteCache,
    locale,
    () =>
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'megabyte',
        maximumFractionDigits: 1,
      }),
  );
  return format.format(bytes / MEBIBYTE);
}
