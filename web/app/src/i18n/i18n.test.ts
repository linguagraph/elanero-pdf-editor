import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../rpc/generated';
import { EN, type MessageId } from './en';
import { createTranslator, t } from './t';

const ids = Object.keys(EN) as MessageId[];

describe('message catalogue (W4.7)', () => {
  it('has an English entry for every RPC error code in the generated union', () => {
    // A new code in generated.ts (W1.2 section 4) fails here until it has a message.
    const missing = ERROR_CODES.filter((code) => !(`error.${code}` in EN));
    expect(missing).toEqual([]);
  });

  it('has no empty messages', () => {
    for (const id of ids) {
      expect(EN[id].trim(), id).not.toBe('');
    }
  });

  it('keeps messages free of markup, so the UI can render them as text', () => {
    for (const id of ids) {
      expect(EN[id], id).not.toMatch(/[<>]/);
    }
  });

  it('keeps internal names and codes out of user text', () => {
    for (const id of ids) {
      expect(EN[id], id).not.toMatch(/Error|Exception|Traceback/);
      expect(EN[id], id).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/);
    }
  });

  it('uses only lower-case word placeholders', () => {
    for (const id of ids) {
      for (const match of EN[id].matchAll(/\{([^}]*)\}/g)) {
        expect(match[1], id).toMatch(/^\w+$/);
      }
    }
  });
});

describe('t()', () => {
  it('returns the English text for a key without parameters', () => {
    expect(t('about.licence')).toBe('Licence: AGPL-3.0-or-later');
  });

  it('fills named parameters, including repeated ones', () => {
    const translate = createTranslator({ 'app.version': 'v{version} ({version})' });
    expect(translate('app.version', { version: '1.2.3' })).toBe('v1.2.3 (1.2.3)');
  });

  it('formats numbers as text', () => {
    const translate = createTranslator({ 'app.version': 'page {version}' });
    expect(translate('app.version', { version: 4 })).toBe('page 4');
  });

  it('leaves a placeholder with no value in place', () => {
    expect(t('app.version')).toBe('Version {version}');
  });

  it('falls back to English for a key a catalogue does not have', () => {
    const translate = createTranslator({ 'about.licence': 'Lizenz' });
    expect(translate('about.licence')).toBe('Lizenz');
    expect(translate('about.source')).toBe(EN['about.source']);
  });
});
