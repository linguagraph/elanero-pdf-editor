import { describe, expect, it } from 'vitest';
import { WEB_SHORTCUT_OVERRIDES } from '../../../src/shortcuts.web';
import shortcutTable from '../../../src/generated/shortcuts.json';
import { effectiveKeys } from './bindings';
import { DROPPED_IDS, MENU, REGISTRY } from './catalog';
import { isSharedId, sharedKeys, type CommandState } from './registry';
import {
  commandForEvent,
  displayKeys,
  type KeyEventLike,
  isMacPlatform,
  matchesChord,
  PALETTE_SHORTCUT_ID,
  parseChord,
  shortcutLabel,
} from './shortcuts';

const SHARED: Record<string, { keys: string[] }> = shortcutTable.commands;

const STATE: CommandState = {
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

function event(init: Partial<KeyEventLike> & { key: string }): KeyEventLike {
  return { code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init };
}

describe('the override table', () => {
  it('names only commands that exist in the registry and in the shared table', () => {
    for (const id of Object.keys(WEB_SHORTCUT_OVERRIDES)) {
      expect(REGISTRY.get(id), `override for ${id} has no registry command`).toBeDefined();
      expect(isSharedId(id), `override for ${id} is not in shortcuts.json`).toBe(true);
    }
  });

  it('replaces the shared keys of a command, and leaves the other commands alone', () => {
    expect(effectiveKeys('close')).toEqual(['Alt+W']);
    expect(sharedKeys('close')).toEqual(['Ctrl+W', 'Ctrl+F4']);
    expect(effectiveKeys('crop-pages')).toEqual([]);
    expect(effectiveKeys('undo')).toEqual(sharedKeys('undo'));
  });
});

describe('the S3 overrides and the dropped commands', () => {
  it('binds Go to Page, Next and Previous Document to the web keys', () => {
    expect(effectiveKeys('go-to-page')).toEqual(['Alt+G']);
    expect(effectiveKeys('next-document')).toEqual(['Alt+PgDn']);
    expect(effectiveKeys('previous-document')).toEqual(['Alt+PgUp']);
  });

  it('matches Alt+G, Alt+PgDn and Alt+PgUp to their commands on the web', () => {
    expect(
      commandForEvent(event({ key: 'g', code: 'KeyG', altKey: true }), REGISTRY, STATE, false),
    ).toBe('go-to-page');
    expect(commandForEvent(event({ key: 'PageDown', altKey: true }), REGISTRY, STATE, false)).toBe(
      'next-document',
    );
    expect(commandForEvent(event({ key: 'PageUp', altKey: true }), REGISTRY, STATE, false)).toBe(
      'previous-document',
    );
  });

  it('keeps New Window and Exit out of the registry, the menu and the overrides', () => {
    expect([...DROPPED_IDS].sort()).toEqual(['exit', 'new-window']);
    for (const id of DROPPED_IDS) {
      expect(REGISTRY.get(id), id).toBeUndefined();
      expect(MENU.flat(), id).not.toContain(id);
      expect(Object.keys(WEB_SHORTCUT_OVERRIDES), id).not.toContain(id);
      expect(isSharedId(id), id).toBe(true);
    }
    expect(commandForEvent(event({ key: 'n', ctrlKey: true }), REGISTRY, STATE, false)).toBe(
      undefined,
    );
  });

  it('keeps the dropped commands out of the Keyboard Shortcuts list', () => {
    const listed = REGISTRY.commands.map((def) => def.id);
    for (const id of DROPPED_IDS) expect(listed).not.toContain(id);
  });
});

describe('the shortcuts of the registry', () => {
  it('come from the shared table, or from the override table where one exists', () => {
    for (const def of REGISTRY.commands) {
      const override = WEB_SHORTCUT_OVERRIDES[def.id];
      expect(effectiveKeys(def.id)).toEqual(override ?? sharedKeys(def.id));
      if (override === undefined) {
        expect(effectiveKeys(def.id)).toEqual(SHARED[def.id]?.keys ?? []);
      }
    }
  });

  it('are all parsed into a key the event matcher can use', () => {
    for (const def of REGISTRY.commands) {
      for (const text of effectiveKeys(def.id)) {
        expect(parseChord(text).key, `${def.id}: ${text}`).not.toBe('');
      }
    }
  });
});

describe('parsing and matching', () => {
  it('parses modifiers and the key names the table uses', () => {
    expect(parseChord('Ctrl+Shift+P')).toEqual({ ctrl: true, shift: true, alt: false, key: 'p' });
    expect(parseChord('Alt+Left')).toEqual({
      ctrl: false,
      shift: false,
      alt: true,
      key: 'arrowleft',
    });
    expect(parseChord('Ctrl+Shift+Tab').key).toBe('tab');
    expect(parseChord('Ctrl+-').key).toBe('-');
  });

  it('matches an event on its modifiers and key, and not on extra modifiers', () => {
    const undo = parseChord('Ctrl+Z');
    expect(matchesChord(event({ key: 'z', ctrlKey: true }), undo, false)).toBe(true);
    expect(matchesChord(event({ key: 'Z', ctrlKey: true, shiftKey: true }), undo, false)).toBe(
      false,
    );
    expect(matchesChord(event({ key: 'z' }), undo, false)).toBe(false);
  });

  it('treats Ctrl as Command on macOS, and matches letters by their physical key under Alt', () => {
    const save = parseChord('Ctrl+S');
    expect(matchesChord(event({ key: 's', metaKey: true }), save, true)).toBe(true);
    expect(matchesChord(event({ key: 's', ctrlKey: true }), save, true)).toBe(false);
    expect(
      matchesChord(event({ key: 'ø', code: 'KeyO', altKey: true }), parseChord('Alt+O'), false),
    ).toBe(true);
  });

  it('finds the palette before any command, and the command an event asks for', () => {
    expect(
      commandForEvent(event({ key: 'P', ctrlKey: true, shiftKey: true }), REGISTRY, STATE, false),
    ).toBe(PALETTE_SHORTCUT_ID);
    expect(commandForEvent(event({ key: 'z', ctrlKey: true }), REGISTRY, STATE, false)).toBe(
      'undo',
    );
    expect(
      commandForEvent(event({ key: 'q', ctrlKey: true }), REGISTRY, STATE, false),
    ).toBeUndefined();
  });

  it('formats keys for the platform, with Ctrl shown as Cmd on macOS', () => {
    expect(displayKeys(['Ctrl+Shift+P', 'Alt+W'], false)).toBe('Ctrl+Shift+P, Alt+W');
    expect(displayKeys(['Ctrl+Shift+P'], true)).toBe('Cmd+Shift+P');
    expect(isMacPlatform('MacIntel')).toBe(true);
    expect(isMacPlatform('Win32')).toBe(false);
  });

  it('does not match Control+H on macOS, so the Hand tool keeps its plain H only', () => {
    const hand = parseChord('H');
    const control = event({ key: 'h', code: 'KeyH', ctrlKey: true });
    expect(matchesChord(control, hand, true)).toBe(false);
    expect(matchesChord(event({ key: 'h', code: 'KeyH', metaKey: true }), hand, true)).toBe(false);
    expect(matchesChord(event({ key: 'h', code: 'KeyH' }), hand, true)).toBe(true);
    expect(matchesChord(control, hand, false)).toBe(false);
    expect(
      matchesChord(event({ key: 's', ctrlKey: true, metaKey: true }), parseChord('Ctrl+S'), false),
    ).toBe(false);
  });

  it('labels a ribbon command with the key the web binds, not the desktop key', () => {
    expect(shortcutLabel('go-to-page', false)).toBe('Alt+G');
    expect(shortcutLabel('go-to-page', true)).toBe('Alt+G');
    expect(shortcutLabel('save', false)).toBe('Ctrl+S');
    expect(shortcutLabel('save', true)).toBe('Cmd+S');
    // A command the web has unbound (its override is empty) has no label, even though the desktop
    // binds it.
    expect(shortcutLabel('crop-pages', false)).toBeUndefined();
    expect(shortcutLabel('insert-pages', true)).toBeUndefined();
    expect(shortcutLabel('comments-list', false)).toBeUndefined();
  });
});
