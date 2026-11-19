import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../prefs/store';
import {
  RECENT_COMMANDS_KEY,
  RECENT_COMMANDS_LIMIT,
  readRecentCommands,
  recordRecentCommand,
} from './recentCommands';

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function stored(): unknown {
  return JSON.parse(window.localStorage.getItem(RECENT_COMMANDS_KEY) ?? 'null');
}

describe('recent commands', () => {
  it('keeps the newest first, moves a repeat to the front and cuts the list to the limit', () => {
    for (let i = 0; i < 10; i += 1) recordRecentCommand(`cmd-${i}`);
    expect(readRecentCommands()).toHaveLength(RECENT_COMMANDS_LIMIT);
    expect(readRecentCommands()[0]).toBe('cmd-9');

    recordRecentCommand('cmd-3');
    const list = readRecentCommands();
    expect(list[0]).toBe('cmd-3');
    expect(list.filter((id) => id === 'cmd-3')).toHaveLength(1);
    expect(list).toHaveLength(RECENT_COMMANDS_LIMIT);
  });

  it('stores a JSON array of ids under the elanero.recentCommands key', () => {
    recordRecentCommand('undo');
    recordRecentCommand('redo');
    expect(RECENT_COMMANDS_KEY).toBe('elanero.recentCommands');
    expect(stored()).toEqual(['redo', 'undo']);
  });

  it('drops malformed JSON, a non-array, non-string items, repeats and overlong ids', () => {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, '{not json');
    expect(readRecentCommands()).toEqual([]);

    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify({ id: 'undo' }));
    expect(readRecentCommands()).toEqual([]);

    const long = 'x'.repeat(65);
    window.localStorage.setItem(
      RECENT_COMMANDS_KEY,
      JSON.stringify(['undo', 7, null, 'undo', long, 'redo']),
    );
    expect(readRecentCommands()).toEqual(['undo', 'redo']);
  });

  it('keeps ids the registry does not know, so a newer build keeps its own', () => {
    window.localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(['future-command']));
    recordRecentCommand('undo');
    expect(stored()).toEqual(['undo', 'future-command']);
  });

  it('gives an empty list and no exception when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readRecentCommands()).toEqual([]);
    expect(() => recordRecentCommand('undo')).not.toThrow();
  });

  it('writes through writeStoredValue', () => {
    const spy = vi.spyOn(store, 'writeStoredValue');
    recordRecentCommand('undo');
    expect(spy).toHaveBeenCalledWith(RECENT_COMMANDS_KEY, JSON.stringify(['undo']));
  });

  it('ignores an empty or overlong id when recording', () => {
    recordRecentCommand('');
    recordRecentCommand('x'.repeat(65));
    expect(window.localStorage.getItem(RECENT_COMMANDS_KEY)).toBeNull();
  });
});
