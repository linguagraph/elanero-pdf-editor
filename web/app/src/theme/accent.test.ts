import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { ACCENT_CHOICES, applyAccent, initAccent, isAccentChoice } from './accent';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-accent');
});

describe('applyAccent', () => {
  it('sets data-accent for a preset', () => {
    applyAccent('teal');
    expect(document.documentElement.getAttribute('data-accent')).toBe('teal');
  });

  it('removes data-accent for Blue, the default look', () => {
    applyAccent('teal');
    applyAccent('blue');
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false);
  });
});

describe('initAccent', () => {
  it('applies the stored choice before the first render', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ accent: 'pink' }));
    expect(initAccent()).toBe('pink');
    expect(document.documentElement.getAttribute('data-accent')).toBe('pink');
  });

  it('leaves Blue when nothing is stored', () => {
    expect(initAccent()).toBe('blue');
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false);
  });

  it('survives a throwing localStorage with the default', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => initAccent()).not.toThrow();
    expect(initAccent()).toBe('blue');
  });
});

describe('accent choices', () => {
  it('lists the eight desktop presets in order, Blue first', () => {
    expect(ACCENT_CHOICES).toEqual([
      'blue',
      'teal',
      'green',
      'purple',
      'pink',
      'red',
      'orange',
      'graphite',
    ]);
  });

  it('accepts only a listed preset', () => {
    expect(isAccentChoice('graphite')).toBe(true);
    expect(isAccentChoice('Teal')).toBe(false);
    expect(isAccentChoice(null)).toBe(false);
  });
});
