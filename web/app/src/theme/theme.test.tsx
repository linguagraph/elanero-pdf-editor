import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  initTheme,
  readStoredTheme,
  setTheme,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from './theme';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('applyTheme', () => {
  it.each<[ThemeChoice, string | null]>([
    ['light', 'light'],
    ['dark', 'dark'],
    ['system', null],
  ])('sets data-theme for %s to %s', (choice, attribute) => {
    applyTheme(choice);
    expect(document.documentElement.getAttribute('data-theme')).toBe(attribute);
  });

  it('replaces an earlier choice rather than keeping it', () => {
    applyTheme('dark');
    applyTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('stored choice', () => {
  it('round-trips through setTheme and initTheme', () => {
    setTheme('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    document.documentElement.removeAttribute('data-theme');
    expect(initTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('falls back to system for an unknown stored value', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme()).toBe('system');
  });

  it('does not throw when localStorage is unavailable, and still applies the choice', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(readStoredTheme()).toBe('system');
    expect(() => setTheme('light')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(() => initTheme()).not.toThrow();
  });
});

describe('ThemeSwitch in the shell', () => {
  it('sets data-theme when the user picks each choice, and keeps the choice on reload', async () => {
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { ThemeSwitch } = await import('./ThemeSwitch');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<ThemeSwitch />);
      });
      const pick = (label: string) => {
        const input = [...host.querySelectorAll('input')].find(
          (el) => el.value === label.toLowerCase(),
        );
        if (!input) throw new Error(`no ${label} option`);
        act(() => {
          input.click();
        });
      };
      pick('Dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
      pick('Light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
      pick('System');
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
