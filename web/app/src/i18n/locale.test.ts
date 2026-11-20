import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANGUAGE_CHOICES } from '../prefs/store';
import { EN } from './en';
import {
  applyLocale,
  isRightToLeft,
  LOCALE_LOAD_TIMEOUT_MS,
  LOCALE_LOADERS,
  loadCatalogue,
  startWithLocale,
  validateCatalogue,
  type LoaderMap,
} from './locale';
import { createTranslator, getLocale, setLocale, t } from './t';
import plFixture from './__fixtures__/pl.json';

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'locales');

// The fixture is a valid Polish file. Each test copies it and breaks one entry.
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plFixture)) as Record<string, unknown>;
}

afterEach(() => {
  setLocale('en', {});
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
  vi.restoreAllMocks();
});

describe('validateCatalogue', () => {
  it('accepts the fixture with no problems', () => {
    const { catalogue, problems } = validateCatalogue(plFixture, 'pl');
    expect(problems).toEqual([]);
    expect(Object.keys(catalogue).sort()).toEqual(Object.keys(plFixture).sort());
  });

  it('drops an unknown key', () => {
    const raw = { ...fixture(), 'no.such.key': 'x' };
    const { catalogue, problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/no\.such\.key: unknown key/);
    expect(catalogue).not.toHaveProperty('no.such.key');
  });

  it('drops text where English has a plural', () => {
    const raw = { ...fixture(), 'sample.pages': 'strony' };
    const { catalogue, problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/sample\.pages: expected plural forms/);
    expect(catalogue).not.toHaveProperty('sample.pages');
  });

  it('drops a plural where English has text', () => {
    const raw = { ...fixture(), 'app.version': { one: 'Wersja {version}', other: 'x' } };
    const { catalogue, problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/app\.version: expected text/);
    expect(catalogue).not.toHaveProperty('app.version');
  });

  it('drops a plural without an other form', () => {
    const raw = { ...fixture(), 'sample.pages': { one: '{count} strona' } };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/sample\.pages: plural without an "other" form/);
  });

  it('drops a plural category that Polish does not use', () => {
    const raw = {
      ...fixture(),
      'sample.pages': { ...(fixture()['sample.pages'] as object), two: '{count} x' },
    };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/plural category "two" is not used by this language/);
  });

  it('drops a plural category name that is not a CLDR category', () => {
    const raw = {
      ...fixture(),
      'sample.pages': { ...(fixture()['sample.pages'] as object), lots: '{count}' },
    };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/plural category "lots"/);
  });

  it('drops text whose placeholders differ from English', () => {
    const raw = { ...fixture(), 'app.version': 'Wersja {ver}' };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/app\.version: placeholders differ from English/);
  });

  it('drops a plural form that adds a placeholder English does not have', () => {
    const raw = {
      ...fixture(),
      'rail.count': { ...(fixture()['rail.count'] as object), one: '{panel} {total}' },
    };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/placeholder \{total\} is not in English/);
  });

  it('keeps a plural form that leaves out {count}', () => {
    // The fixture's `one` form for rail.count already leaves out {count}.
    const { catalogue, problems } = validateCatalogue(plFixture, 'pl');
    expect(problems).toEqual([]);
    expect(catalogue['rail.count']).toMatchObject({ one: '{panel}, 1 element' });
  });

  it('drops an empty text', () => {
    const raw = { ...fixture(), 'about.licence': '   ' };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/about\.licence: empty text/);
  });

  it('drops text with markup', () => {
    const raw = { ...fixture(), 'about.licence': '<b>Licencja</b>: AGPL-3.0-or-later' };
    const { problems } = validateCatalogue(raw, 'pl');
    expect(problems.join('\n')).toMatch(/about\.licence: markup in text/);
  });

  it('reports a file that is not a JSON object and returns an empty catalogue', () => {
    expect(validateCatalogue(['x'], 'pl')).toEqual({
      catalogue: {},
      problems: ['pl: the file is not a JSON object'],
    });
  });

  it('keeps the rest of a file when one entry is dropped', () => {
    const raw = { ...fixture(), 'app.version': 'Wersja {ver}' };
    const { catalogue } = validateCatalogue(raw, 'pl');
    expect(catalogue['about.licence']).toBe('Licencja: AGPL-3.0-or-later');
  });
});

describe('loadCatalogue', () => {
  it('returns no catalogue for English', async () => {
    const loaders: LoaderMap = { './locales/en.json': () => Promise.resolve(plFixture) };
    await expect(loadCatalogue('en', loaders)).resolves.toEqual({});
  });

  it('returns no catalogue for a language with no file', async () => {
    await expect(loadCatalogue('xx', {})).resolves.toEqual({});
  });

  it('returns the validated catalogue of a loaded file', async () => {
    const loaders: LoaderMap = { './locales/pl.json': () => Promise.resolve(plFixture) };
    const catalogue = await loadCatalogue('pl', loaders);
    expect(catalogue['app.version']).toBe('Wersja {version}');
  });

  it('returns no catalogue and warns when the import is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaders: LoaderMap = {
      './locales/pl.json': () => Promise.reject(new Error('network down')),
    };
    await expect(loadCatalogue('pl', loaders)).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('network down'));
  });

  it('warns about each dropped entry of a loaded file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaders: LoaderMap = {
      './locales/pl.json': () => Promise.resolve({ 'no.such.key': 'x' }),
    };
    await loadCatalogue('pl', loaders);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no.such.key'));
  });

  it('falls back to English one key at a time', async () => {
    const loaders: LoaderMap = { './locales/pl.json': () => Promise.resolve(plFixture) };
    setLocale('pl', await loadCatalogue('pl', loaders));
    expect(t('app.version', { version: '1' })).toBe('Wersja 1');
    expect(t('about.source')).toBe(EN['about.source']);
  });

  it('uses the fixture plural rules of its language for tp', async () => {
    const loaders: LoaderMap = { './locales/pl.json': () => Promise.resolve(plFixture) };
    const translate = createTranslator(await loadCatalogue('pl', loaders), 'pl').tp;
    expect(translate('sample.pages', 1)).toBe('1 strona');
    expect(translate('sample.pages', 3)).toBe('3 strony');
    expect(translate('sample.pages', 5)).toBe('5 stron');
  });
});

describe('applyLocale', () => {
  it('sets the active locale and the page language and direction', () => {
    applyLocale('pl', {});
    expect(getLocale()).toBe('pl');
    expect(document.documentElement.lang).toBe('pl');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('sets dir="rtl" for a right-to-left language', () => {
    applyLocale('ar', {});
    expect(document.documentElement.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('knows the right-to-left languages and no others', () => {
    expect(isRightToLeft('ar')).toBe(true);
    expect(isRightToLeft('he')).toBe(true);
    expect(isRightToLeft('pl')).toBe(false);
    expect(isRightToLeft('en')).toBe(false);
  });
});

describe('shipped locale files', () => {
  const files = existsSync(LOCALES_DIR)
    ? readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json'))
    : [];

  it('finds the locales folder and the glob sees the same files', () => {
    expect(existsSync(LOCALES_DIR)).toBe(true);
    expect(Object.keys(LOCALE_LOADERS).sort()).toEqual(
      files.map((name) => `./locales/${name}`).sort(),
    );
  });

  it('validates every shipped locale file with no problems', () => {
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      expect(validateCatalogue(raw, file.slice(0, -'.json'.length)).problems, file).toEqual([]);
    }
  });

  it('lists every shipped locale in LANGUAGE_CHOICES', () => {
    const names = files.map((name) => name.slice(0, -'.json'.length)).sort();
    expect([...LANGUAGE_CHOICES]).toEqual(['en', ...names]);
  });
});

describe('loadCatalogue timeout and start-up fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a load that never resolves falls back to {} within the timeout', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaders: LoaderMap = { './locales/pl.json': () => new Promise<unknown>(() => {}) };
    const pending = loadCatalogue('pl', loaders);
    await vi.advanceTimersByTimeAsync(LOCALE_LOAD_TIMEOUT_MS - 1);
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({});
    expect(warn.mock.calls.join('\n')).toMatch(/pl did not load within 3000 ms/);
  });

  it('a load that rejects falls back to {}', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaders: LoaderMap = {
      './locales/pl.json': () => Promise.reject(new Error('network down')),
    };
    await expect(loadCatalogue('pl', loaders)).resolves.toEqual({});
    expect(warn.mock.calls.join('\n')).toMatch(/could not load pl: network down/);
  });

  it('a file that arrives in time is used and its timer is cleared', async () => {
    vi.useFakeTimers();
    const loaders: LoaderMap = { './locales/pl.json': () => Promise.resolve(fixture()) };
    const catalogue = await loadCatalogue('pl', loaders);
    expect(Object.keys(catalogue).length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the app mounts after a stalled load, with the language but no translations', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loaders: LoaderMap = { './locales/pl.json': () => new Promise<unknown>(() => {}) };
    const mount = vi.fn();
    const done = startWithLocale('pl', mount, (lang) => loadCatalogue(lang, loaders));
    await vi.advanceTimersByTimeAsync(LOCALE_LOAD_TIMEOUT_MS);
    await done;
    expect(mount).toHaveBeenCalledTimes(1);
    expect(getLocale()).toBe('pl');
  });

  it('the app mounts in English after a rejected load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = vi.fn();
    await startWithLocale('pl', mount, () => Promise.reject(new Error('boom')));
    expect(mount).toHaveBeenCalledTimes(1);
    expect(document.documentElement.lang).toBe('en');
  });

  it('the app still mounts, in English, when mounting throws the first time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mount = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error('first mount failed');
      })
      .mockImplementation(() => undefined);
    await startWithLocale('pl', mount, () => Promise.resolve({}));
    expect(mount).toHaveBeenCalledTimes(2);
    expect(document.documentElement.lang).toBe('en');
    expect(warn.mock.calls.join('\n')).toMatch(/start-up failed for pl/);
  });
});
