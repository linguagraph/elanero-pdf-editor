import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  onPreferencesChanged,
  PREFERENCES_CHANGED_EVENT,
  writePreferences,
} from './store';

// The change event tells an open view to re-read the saved default zoom, so it must come only when
// the write was kept: a failed write changes nothing the view would read.
describe('writePreferences announces a kept change only', () => {
  const listener = vi.fn<() => void>();
  const onEvent = () => listener();

  beforeEach(() => {
    window.localStorage.clear();
    listener.mockClear();
    window.addEventListener(PREFERENCES_CHANGED_EVENT, onEvent);
  });

  afterEach(() => {
    window.removeEventListener(PREFERENCES_CHANGED_EVENT, onEvent);
    vi.restoreAllMocks();
  });

  it('dispatches the event after a kept write, and returns true', () => {
    expect(writePreferences({ ...DEFAULT_PREFERENCES, defaultZoom: 'fitPage' })).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch the event when the browser refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(writePreferences({ ...DEFAULT_PREFERENCES, defaultZoom: 'fitPage' })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a listener stop, so the view can unmount cleanly', () => {
    const seen = vi.fn();
    const stop = onPreferencesChanged(seen);
    stop();
    writePreferences(DEFAULT_PREFERENCES);
    expect(seen).not.toHaveBeenCalled();
  });
});
