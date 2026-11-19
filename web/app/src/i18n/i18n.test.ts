import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../rpc/generated';
import { EN, type AnyMessageId } from './en';
import { formatDate, formatNumber } from './format';
import { createTranslator, setLocale, t, tp } from './t';

const ids = Object.keys(EN) as AnyMessageId[];

// The text of each form of an entry: one string for a text key, every plural form otherwise.
function formsOf(id: AnyMessageId): string[] {
  const entry = EN[id];
  return typeof entry === 'string' ? [entry] : Object.values(entry);
}

describe('message catalogue (W4.7)', () => {
  it('has an English entry for every RPC error code in the generated union', () => {
    // A new code in generated.ts (W1.2 section 4) fails here until it has a message.
    const missing = ERROR_CODES.filter((code) => !(`error.${code}` in EN));
    expect(missing).toEqual([]);
  });

  it('has no empty messages', () => {
    for (const id of ids) {
      for (const form of formsOf(id)) {
        expect(form.trim(), id).not.toBe('');
      }
    }
  });

  it('keeps messages free of markup, so the UI can render them as text', () => {
    for (const id of ids) {
      for (const form of formsOf(id)) {
        expect(form, id).not.toMatch(/[<>]/);
      }
    }
  });

  it('keeps internal names and codes out of user text', () => {
    for (const id of ids) {
      for (const form of formsOf(id)) {
        expect(form, id).not.toMatch(/Error|Exception|Traceback/);
        expect(form, id).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/);
      }
    }
  });

  it('uses only lower-case word placeholders', () => {
    for (const id of ids) {
      for (const form of formsOf(id)) {
        for (const match of form.matchAll(/\{([^}]*)\}/g)) {
          expect(match[1], id).toMatch(/^\w+$/);
        }
      }
    }
  });

  it('gives every English plural exactly the one and other forms', () => {
    for (const id of ids) {
      const entry = EN[id];
      if (typeof entry === 'string') continue;
      expect(Object.keys(entry).sort(), id).toEqual(['one', 'other']);
    }
  });
});

describe('t()', () => {
  it('returns the English text for a key without parameters', () => {
    expect(t('about.licence')).toBe('Licence: AGPL-3.0-or-later');
  });

  it('fills named parameters, including repeated ones', () => {
    const { t: translate } = createTranslator({ 'app.version': 'v{version} ({version})' });
    expect(translate('app.version', { version: '1.2.3' })).toBe('v1.2.3 (1.2.3)');
  });

  it('formats numbers as text', () => {
    const { t: translate } = createTranslator({ 'app.version': 'page {version}' });
    expect(translate('app.version', { version: 4 })).toBe('page 4');
  });

  it('leaves a placeholder with no value in place', () => {
    expect(t('app.version')).toBe('Version {version}');
  });

  it('falls back to English for a key a catalogue does not have', () => {
    const { t: translate } = createTranslator({ 'about.licence': 'Lizenz' });
    expect(translate('about.licence')).toBe('Lizenz');
    expect(translate('about.source')).toBe(EN['about.source']);
  });
});

describe('tp() plural forms', () => {
  afterEach(() => setLocale('en', {}));

  it('picks the English one form for 1 and the other form for 0 and 2', () => {
    expect(tp('sample.pages', 1)).toBe('1 page');
    expect(tp('sample.pages', 0)).toBe('0 pages');
    expect(tp('sample.pages', 2)).toBe('2 pages');
  });

  it('formats the count with grouping for the locale', () => {
    expect(tp('sample.pages', 1000)).toBe('1,000 pages');
  });

  it('selects Polish forms with the Polish rules of the catalogue it came from', () => {
    const { tp: translate } = createTranslator(
      {
        'sample.pages': {
          one: '{count} A',
          few: '{count} B',
          many: '{count} C',
          other: '{count} D',
        },
      },
      'pl',
    );
    expect(translate('sample.pages', 1)).toBe('1 A');
    expect(translate('sample.pages', 2)).toBe('2 B');
    expect(translate('sample.pages', 5)).toBe('5 C');
    expect(translate('sample.pages', 22)).toBe('22 B');
    expect(translate('sample.pages', 1.5)).toBe('1,5 D');
  });

  it('falls back to the English plural, chosen by English rules, for a key the catalogue lacks', () => {
    const { tp: translate } = createTranslator({ 'about.licence': 'Lizenz' }, 'pl');
    expect(translate('sample.pages', 1)).toBe('1 page');
    expect(translate('sample.pages', 2)).toBe('2 pages');
  });

  it('falls back to the other form when the entry lacks the selected category', () => {
    const { tp: translate } = createTranslator(
      { 'sample.pages': { one: '{count} A', other: '{count} D' } },
      'pl',
    );
    expect(translate('sample.pages', 2)).toBe('2 D');
  });

  it('throws in dev when params carries the count', () => {
    expect(() => tp('sample.pages', 1, { count: 3 })).toThrow(/second argument/);
  });

  it('fills other params alongside the count', () => {
    const { tp: translate } = createTranslator({
      'sample.pages': { one: '{count} page of {name}', other: '{count} pages of {name}' },
    });
    expect(translate('sample.pages', 3, { name: 'Doc' })).toBe('3 pages of Doc');
  });
});

describe('locale-aware formatting', () => {
  afterEach(() => setLocale('en', {}));

  it('formats numbers and dates for the active locale', () => {
    const date = new Date(2026, 0, 15, 9, 30);
    setLocale('de', {});
    expect(formatNumber(1234)).toBe('1.234');
    expect(formatDate(date)).toBe(
      new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short' }).format(date),
    );
    setLocale('en', {});
    expect(formatNumber(1234)).toBe('1,234');
  });
});
