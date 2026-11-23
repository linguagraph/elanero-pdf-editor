import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandState, sharedKeys } from './registry';

// The store keeps its state in module variables, so each test loads a fresh copy of the module
// after the test has set localStorage.
type Bindings = typeof import('./bindings');

async function loadBindings(): Promise<Bindings> {
  vi.resetModules();
  return import('./bindings');
}

const KEY = 'elanero.shortcuts';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('stored bindings', () => {
  it('uses the defaults when nothing is stored', async () => {
    const b = await loadBindings();
    expect(b.effectiveKeys('close')).toEqual(['Alt+W']);
    expect(b.effectiveKeys('save')).toEqual(sharedKeys('save'));
    expect(b.userKeys('save')).toBeUndefined();
  });

  it('applies a valid stored binding', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': ['Ctrl+Alt+F'], 'crop-pages': [] } }),
    );
    const b = await loadBindings();
    expect(b.effectiveKeys('fit-width')).toEqual(['Ctrl+Alt+F']);
    expect(b.effectiveKeys('crop-pages')).toEqual([]);
  });

  it.each([
    ['corrupt JSON', '{not json'],
    ['an unknown version', JSON.stringify({ version: 2, bindings: { save: [] } })],
    ['a non-object', '[1,2]'],
    ['bindings that are not an object', JSON.stringify({ version: 1, bindings: 'x' })],
  ])('falls back to the defaults for %s', async (_name, raw) => {
    window.localStorage.setItem(KEY, raw);
    const b = await loadBindings();
    expect(b.effectiveKeys('save')).toEqual(sharedKeys('save'));
  });

  it('drops an unknown id and a stored chord in a refused class, and keeps the rest', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        bindings: {
          'no-such-command': ['Ctrl+Alt+Q'],
          'fit-width': ['Ctrl+W'],
          'crop-pages': ['Ctrl+Alt+Shift+C'],
        },
      }),
    );
    const b = await loadBindings();
    expect(b.effectiveKeys('fit-width')).toEqual(sharedKeys('fit-width'));
    expect(b.effectiveKeys('crop-pages')).toEqual(['Ctrl+Alt+Shift+C']);
  });

  it('keeps the defaults and never throws when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const b = await loadBindings();
    expect(b.effectiveKeys('save')).toEqual(sharedKeys('save'));
  });

  it('applies a change for this page view when the write fails', async () => {
    const b = await loadBindings();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(b.assign('fit-width', ['Ctrl+Alt+F'])).toBe(false);
    expect(b.effectiveKeys('fit-width')).toEqual(['Ctrl+Alt+F']);
  });

  it('stores only real changes: a value equal to the default drops the entry', async () => {
    const b = await loadBindings();
    expect(b.assign('close', ['Alt+W'])).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(b.assign('fit-width', ['Ctrl+Alt+F'])).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? '{}')).toEqual({
      version: 1,
      bindings: { 'fit-width': ['Ctrl+Alt+F'] },
    });
  });

  it('resets one command, then all of them', async () => {
    const b = await loadBindings();
    b.assign('fit-width', ['Ctrl+Alt+F']);
    b.assign('save', []);
    b.reset('fit-width');
    expect(b.effectiveKeys('fit-width')).toEqual(sharedKeys('fit-width'));
    expect(b.effectiveKeys('save')).toEqual([]);
    b.reset();
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(b.effectiveKeys('save')).toEqual(sharedKeys('save'));
  });
});

describe('check', () => {
  it('refuses a key the browser keeps', async () => {
    const b = await loadBindings();
    expect(b.check('fit-width', 'Ctrl+W')).toEqual({ kind: 'refuse', reason: 'browser' });
    expect(b.check('fit-width', 'Ctrl+Shift+T')).toEqual({ kind: 'refuse', reason: 'browser' });
  });

  it('refuses OS keys, Alt+Tab and Ctrl+Alt+Delete', async () => {
    const b = await loadBindings();
    expect(b.check('fit-width', 'Alt+Tab')).toEqual({ kind: 'refuse', reason: 'os' });
    expect(b.check('fit-width', 'Ctrl+Alt+Delete')).toEqual({ kind: 'refuse', reason: 'os' });
  });

  it('refuses Elanero keys for moving around and editing', async () => {
    const b = await loadBindings();
    for (const text of ['Tab', 'Shift+Tab', 'Escape', 'Enter', 'Delete', 'PgDn', 'Shift+Home']) {
      expect(b.check('fit-width', text), text).toEqual({ kind: 'refuse', reason: 'app' });
    }
    expect(b.check('fit-width', 'F6')).toEqual({ kind: 'refuse', reason: 'app' });
    expect(b.check('fit-width', 'Alt+Shift+N')).toEqual({ kind: 'refuse', reason: 'app' });
    expect(b.check('fit-width', 'Alt+Shift+Left')).toEqual({ kind: 'refuse', reason: 'app' });
  });

  it('refuses a duplicate of another command, whatever the spelling', async () => {
    const b = await loadBindings();
    const result = b.check('fit-width', 'Shift+Ctrl+S');
    // Ctrl+Shift+S is Save As on the desktop table.
    expect(result).toEqual({ kind: 'refuse', reason: 'duplicate', otherId: 'save-as' });
  });

  it('does not count a command against itself', async () => {
    const b = await loadBindings();
    expect(b.check('save', 'Ctrl+S')).toEqual({ kind: 'ok' });
  });

  it('refuses an unparseable chord', async () => {
    const b = await loadBindings();
    expect(b.check('fit-width', 'Ctrl+')).toEqual({ kind: 'refuse', reason: 'invalid' });
  });

  it('warns about a bare letter, and allows a chord with Ctrl and Alt', async () => {
    const b = await loadBindings();
    const bare = 'abcdefghijklmnopqrstuvwxyz'
      .split('')
      .find((letter) => b.check('fit-width', letter.toUpperCase()).kind !== 'refuse');
    expect(bare).toBeDefined();
    expect(b.check('fit-width', bare!.toUpperCase())).toEqual({ kind: 'warn', reason: 'letter' });
    expect(b.check('fit-width', 'Ctrl+Alt+Shift+9')).toEqual({ kind: 'ok' });
  });
});

describe('check, by class', () => {
  it('warns that a browser may keep a digit chord, when no command holds it', async () => {
    const b = await loadBindings();
    expect(b.check('fit-width', 'Ctrl+3')).toEqual({ kind: 'warn', reason: 'browserMayKeep' });
    expect(b.check('fit-width', 'Ctrl+=')).toEqual({ kind: 'warn', reason: 'browserMayKeep' });
  });

  it('refuses Ctrl+E as a duplicate of Properties, before the browser-may-keep warning', async () => {
    // Ctrl+E is in the browser-may-keep group, but the shared table gives it to Properties, and a
    // duplicate is checked before a warning (chord checks run refuse, duplicate, then warn).
    const b = await loadBindings();
    expect(b.check('fit-width', 'Ctrl+E')).toEqual({
      kind: 'refuse',
      reason: 'duplicate',
      otherId: 'properties-panel',
    });
  });

  it('refuses a duplicate of the palette key, whatever the spelling', async () => {
    const b = await loadBindings();
    expect(b.check('fit-width', 'Shift+Ctrl+P')).toEqual({
      kind: 'refuse',
      reason: 'duplicate',
      otherId: 'command-palette',
    });
  });

  it('refuses a duplicate of a shared-table id that is not in the registry', async () => {
    // Paste Comments is in the shared table only. F6 would be refused as an app key first, so it
    // cannot show the duplicate rule; Ctrl+V can.
    const b = await loadBindings();
    expect(b.check('fit-width', 'Ctrl+V')).toEqual({
      kind: 'refuse',
      reason: 'duplicate',
      otherId: 'paste-comments',
    });
  });
});

describe('stored values checked on load', () => {
  it('drops a stored chord that does not parse, so the command falls back to its default', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': ['Ctrl+'] } }),
    );
    const b = await loadBindings();
    expect(b.userKeys('fit-width')).toBeUndefined();
    expect(b.effectiveKeys('fit-width')).toEqual(sharedKeys('fit-width'));
  });

  it('drops a stored value that is not a list', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': 'Ctrl+Alt+F' } }),
    );
    const b = await loadBindings();
    expect(b.userKeys('fit-width')).toBeUndefined();
    expect(b.effectiveKeys('fit-width')).toEqual(sharedKeys('fit-width'));
  });

  it('keeps only the string entries of a list', async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': ['Ctrl+Alt+F', 42, null, {}] } }),
    );
    const b = await loadBindings();
    expect(b.userKeys('fit-width')).toEqual(['Ctrl+Alt+F']);
    expect(b.effectiveKeys('fit-width')).toEqual(['Ctrl+Alt+F']);
  });

  it('keeps a user binding equal to another command default (user keys win)', async () => {
    // A new release gave Fit Width Ctrl+2 while a user already has Ctrl+2 on Save As. The stored
    // entry stays, and Save As keeps it (design section 5).
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'save-as': ['Ctrl+2'] } }),
    );
    const b = await loadBindings();
    expect(b.userKeys('save-as')).toEqual(['Ctrl+2']);
    expect(b.effectiveKeys('save-as')).toEqual(['Ctrl+2']);
  });

  it('matches a key bound to a user command to that command, not to the default owner', async () => {
    // Save As holds Ctrl+2 by the user; Fit Width keeps its default Ctrl+2 as well. Pressing the
    // key must run the user's command (Save As), which is the design's "user keys win in matching".
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'save-as': ['Ctrl+2'] } }),
    );
    vi.resetModules();
    const { commandForEvent } = await import('./shortcuts');
    const { REGISTRY } = await import('./catalog');
    const state: CommandState = {
      hasDocument: true,
      hasRecentFiles: true,
      canUndo: true,
      canRedo: true,
      capabilities: new Set(),
      contentEdit: false,
      ribbonCompact: false,
      ribbonCollapsed: false,
      viewTool: 'select',
      commentTool: null,
      redacting: false,
      canApplyRedactions: false,
      canGoBack: false,
      canGoForward: false,
      view: null,
    };
    const event = {
      key: '2',
      code: 'Digit2',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(commandForEvent(event, REGISTRY, state, false)).toBe('save-as');
  });

  it('stops a default key that the user moved away from firing that command', async () => {
    // Fit Width's default is Ctrl+2; the user moved it to Ctrl+Alt+F. Ctrl+2 must no longer run
    // Fit Width, and the new key must run it.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': ['Ctrl+Alt+F'] } }),
    );
    vi.resetModules();
    const { commandForEvent } = await import('./shortcuts');
    const { REGISTRY } = await import('./catalog');
    const state: CommandState = {
      hasDocument: true,
      hasRecentFiles: true,
      canUndo: true,
      canRedo: true,
      capabilities: new Set(),
      contentEdit: false,
      ribbonCompact: false,
      ribbonCollapsed: false,
      viewTool: 'select',
      commentTool: null,
      redacting: false,
      canApplyRedactions: false,
      canGoBack: false,
      canGoForward: false,
      view: null,
    };
    const ctrl2 = {
      key: '2',
      code: 'Digit2',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(commandForEvent(ctrl2, REGISTRY, state, false)).not.toBe('fit-width');
    const ctrlAltF = { ...ctrl2, key: 'F', code: 'KeyF', altKey: true };
    expect(commandForEvent(ctrlAltF, REGISTRY, state, false)).toBe('fit-width');
  });
});

describe('always-prevented keys', () => {
  it('stops Ctrl+O, Ctrl+S and Ctrl+P on Windows and Linux, and Cmd on macOS', async () => {
    const b = await loadBindings();
    const base = { shiftKey: false, altKey: false, metaKey: false, ctrlKey: true };
    for (const key of ['o', 'S', 'p']) {
      expect(b.isAlwaysPrevented({ ...base, key }, false), key).toBe(true);
    }
    expect(b.isAlwaysPrevented({ ...base, key: 'o', ctrlKey: false }, false)).toBe(false);
    expect(
      b.isAlwaysPrevented(
        { key: 's', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false },
        true,
      ),
    ).toBe(true);
    expect(b.isAlwaysPrevented({ ...base, key: 'f' }, false)).toBe(false);
  });
});

describe('change notification', () => {
  it('tells subscribers about a change and stops after unsubscribe', async () => {
    const b = await loadBindings();
    const listener = vi.fn();
    const stop = b.subscribeBindings(listener);
    const before = b.bindingsVersion();
    b.assign('fit-width', ['Ctrl+Alt+F']);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(b.bindingsVersion()).toBeGreaterThan(before);
    stop();
    b.reset();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-reads the stored value when another tab writes it', async () => {
    const b = await loadBindings();
    const listener = vi.fn();
    b.subscribeBindings(listener);
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, bindings: { 'fit-width': ['Ctrl+Alt+F'] } }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(b.effectiveKeys('fit-width')).toEqual(['Ctrl+Alt+F']);
  });
});

describe('import guard', () => {
  // Only the binding store reads the default table, so the screens cannot show a stale default.
  it('keeps sharedKeys and defaultShortcut inside src/commands', () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(name) && !relative(srcRoot, path).startsWith('commands')) {
          if (/\b(sharedKeys|defaultShortcut)\b/.test(readFileSync(path, 'utf8'))) {
            offenders.push(relative(srcRoot, path));
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
