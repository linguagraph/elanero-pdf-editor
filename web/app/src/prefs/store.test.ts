import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY } from '../theme/theme';
import {
  DEFAULT_PREFERENCES,
  isSecretKey,
  PAGE_LAYOUT_CHOICES,
  PREFS_STORAGE_KEY,
  readPreferences,
  writePreferences,
  writeStoredValue,
  type Preferences,
} from './store';

const SAVED: Preferences = {
  theme: 'dark',
  language: 'en',
  authorName: 'Ada Lovelace',
  defaultZoom: 'actual',
  reduceMotion: true,
  nightReading: true,
  pageLayout: 'twoPage',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('preferences round trip', () => {
  it('reads back every preference that was written', () => {
    expect(writePreferences(SAVED)).toBe(true);
    expect(readPreferences()).toEqual(SAVED);
  });

  it('keeps the theme in the theme key and the rest in the preferences key', () => {
    writePreferences(SAVED);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}')).toEqual({
      language: 'en',
      authorName: 'Ada Lovelace',
      defaultZoom: 'actual',
      reduceMotion: true,
      nightReading: true,
      pageLayout: 'twoPage',
    });
  });

  it('trims and limits the author name when it is saved', () => {
    writePreferences({ ...SAVED, authorName: `  ${'x'.repeat(100)}  ` });
    expect(readPreferences().authorName).toHaveLength(64);
    writePreferences({ ...SAVED, authorName: '  Ada  ' });
    expect(readPreferences().authorName).toBe('Ada');
  });

  it('returns the defaults when nothing is stored', () => {
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });
});

describe('corrupt or invalid stored values', () => {
  it('falls back to the defaults for corrupt JSON', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, '{not json');
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('falls back to the defaults when the stored JSON is not an object', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, '[1,2,3]');
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('falls back field by field for values of the wrong type or outside the choices', () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        language: 'fr',
        authorName: 5,
        defaultZoom: 'huge',
        reduceMotion: 'yes',
        nightReading: 'on',
      }),
    );
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('falls back to the system theme for an unknown stored theme', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readPreferences().theme).toBe('system');
  });
});

describe('default page layout preference (W4.5 S2)', () => {
  it('defaults to a single column of pages', () => {
    expect(DEFAULT_PREFERENCES.pageLayout).toBe('continuous');
    expect(readPreferences().pageLayout).toBe('continuous');
  });

  it('offers only the layouts that exist (single-page waits for W5.1a)', () => {
    expect(PAGE_LAYOUT_CHOICES).toEqual(['continuous', 'twoPage', 'twoPageCover']);
  });

  it('keeps a valid stored choice and falls back for anything else', () => {
    for (const value of ['twoPage', 'twoPageCover']) {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ pageLayout: value }));
      expect(readPreferences().pageLayout).toBe(value);
    }
    for (const value of ['single', 'TwoPage', 42, null]) {
      window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ pageLayout: value }));
      expect(readPreferences().pageLayout).toBe('continuous');
    }
  });

  it('writes a valid choice and cleans an invalid one to the default', () => {
    writePreferences({ ...SAVED, pageLayout: 'twoPageCover' });
    expect(readPreferences().pageLayout).toBe('twoPageCover');
    writePreferences({ ...SAVED, pageLayout: 'single' as Preferences['pageLayout'] });
    expect(readPreferences().pageLayout).toBe('continuous');
  });
});

describe('night reading preference', () => {
  it('is off by default', () => {
    expect(readPreferences().nightReading).toBe(false);
  });

  it('round-trips through the preferences key without touching the other values', () => {
    writePreferences({ ...SAVED, nightReading: true });
    expect(readPreferences().nightReading).toBe(true);
    writePreferences({ ...readPreferences(), nightReading: false });
    expect(readPreferences()).toEqual({ ...SAVED, nightReading: false });
  });
});

describe('localStorage that throws', () => {
  it('reads the defaults without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readPreferences()).toEqual({ ...DEFAULT_PREFERENCES });
  });

  it('reports a failed save as false, and still applies the theme', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => writePreferences(SAVED)).not.toThrow();
    expect(writePreferences(SAVED)).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('secret keys are refused', () => {
  it.each([
    'password',
    'userPassword',
    'passphrase',
    'token',
    'apiKey',
    'api_key',
    'translation.key',
    'secret',
    'encryptionKeys',
    'pin',
  ])('treats %s as a secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each(['elanero.prefs', 'keyboardShortcuts', 'pinned', 'defaultZoom', 'elanero.theme'])(
    'allows %s',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    },
  );

  it('refuses to write a secret key and writes nothing', () => {
    expect(writeStoredValue('translation.apiKey', 'abc123')).toBe(false);
    expect(window.localStorage.getItem('translation.apiKey')).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  it('writes an ordinary key', () => {
    expect(writeStoredValue('elanero.example', 'v')).toBe(true);
    expect(window.localStorage.getItem('elanero.example')).toBe('v');
  });
});
