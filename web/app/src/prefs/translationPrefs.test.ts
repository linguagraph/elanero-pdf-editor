import { afterEach, describe, expect, it } from 'vitest';
import {
  agreedPatch,
  hasCurrentConsent,
  NOTICE_VERSION,
  withdrawnPatch,
} from '../translate/consent';
import {
  cleanConsent,
  cleanLanguageCode,
  DEFAULT_PREFERENCES,
  PREFS_STORAGE_KEY,
  readPreferences,
  writePreferences,
} from './store';

afterEach(() => {
  window.localStorage.clear();
});

describe('translation preferences (W6.6 section 5)', () => {
  it('are off by default, with no record and no language chosen', () => {
    expect(DEFAULT_PREFERENCES.translationEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.translationTarget).toBe('');
    expect(DEFAULT_PREFERENCES.translationLastSource).toBe('');
    expect(DEFAULT_PREFERENCES.translationConsent).toBeNull();
  });

  it('keep a valid language code and turn anything else into the empty code', () => {
    expect(cleanLanguageCode('pt-BR')).toBe('pt-BR');
    expect(cleanLanguageCode('fr')).toBe('fr');
    expect(cleanLanguageCode('fr&x=1')).toBe('');
    expect(cleanLanguageCode('a'.repeat(17))).toBe('');
    expect(cleanLanguageCode(42)).toBe('');
  });

  it('drop a stored record for another service, a bad date or a bad version', () => {
    const record = { service: 'mymemory', version: 1, at: '2026-11-23T10:00:00.000Z' };
    expect(cleanConsent(record)).toEqual(record);
    expect(cleanConsent({ ...record, service: 'azure' })).toBeNull();
    expect(cleanConsent({ ...record, at: 'not a date' })).toBeNull();
    expect(cleanConsent({ ...record, version: 1.5 })).toBeNull();
    expect(cleanConsent(null)).toBeNull();
  });

  it('round-trip through the one preferences key, and a bad stored value falls back', () => {
    writePreferences({
      ...readPreferences(),
      translationEnabled: true,
      translationTarget: 'de',
      translationLastSource: 'fr',
      translationConsent: { service: 'mymemory', version: 1, at: '2026-11-23T10:00:00.000Z' },
    });
    const back = readPreferences();
    expect(back.translationEnabled).toBe(true);
    expect(back.translationTarget).toBe('de');
    expect(back.translationLastSource).toBe('fr');
    expect(back.translationConsent?.version).toBe(1);

    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ translationEnabled: 'yes', translationTarget: 'x y' }),
    );
    expect(readPreferences().translationEnabled).toBe(false);
    expect(readPreferences().translationTarget).toBe('');
  });
});

describe('translation consent (W6.6 section 7)', () => {
  it('is not given by default', () => {
    expect(hasCurrentConsent(DEFAULT_PREFERENCES)).toBe(false);
  });

  it('is given by agreeing, which also turns translation on', () => {
    const patch = agreedPatch(new Date('2026-11-23T10:00:00.000Z'));
    expect(patch.translationEnabled).toBe(true);
    expect(patch.translationConsent).toEqual({
      service: 'mymemory',
      version: NOTICE_VERSION,
      at: '2026-11-23T10:00:00.000Z',
    });
    expect(hasCurrentConsent(patch)).toBe(true);
  });

  it('is cleared by turning translation off', () => {
    expect(withdrawnPatch()).toEqual({ translationEnabled: false, translationConsent: null });
    expect(hasCurrentConsent(withdrawnPatch())).toBe(false);
  });

  it('asks again for a record made for an older notice', () => {
    const older = { service: 'mymemory', version: NOTICE_VERSION - 1, at: '2026-11-01T00:00:00Z' };
    expect(hasCurrentConsent({ translationConsent: older })).toBe(false);
  });
});
