import { describe, expect, it, vi } from 'vitest';
import shortcutTable from '../../../src/generated/shortcuts.json';
import { EN, type MessageId } from '../i18n/en';
import { COMMANDS, GROUPS, MENU, REGISTRY, WEB_ONLY_IDS } from './catalog';
import {
  type CommandState,
  type CommandDef,
  createRegistry,
  DISABLED_REASON_LABELS,
  isSharedId,
  TAB_LABELS,
  TAB_ORDER,
} from './registry';
import { menuSections, ribbonLayout, runCommand } from './run';

const SHARED: Record<string, { keys: string[] }> = shortcutTable.commands;

function state(overrides: Partial<CommandState> = {}): CommandState {
  return {
    hasDocument: false,
    hasRecentFiles: false,
    canUndo: false,
    canRedo: false,
    capabilities: new Set(),
    ...overrides,
  };
}

const ALL_CAPABILITIES = new Set([
  'signing',
  'ocr',
  'office_import',
  'pdfa',
  'pwa_install',
] as const);

const withDoc = state({ hasDocument: true, capabilities: ALL_CAPABILITIES });

describe('registry declarations', () => {
  it('rejects a duplicate command id', () => {
    const def: CommandDef = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'home.file',
      enabled: () => null,
    };
    expect(() => createRegistry([def, def], GROUPS, [])).toThrow(/duplicate command id: save/);
  });

  it('rejects a command in a group that does not exist', () => {
    const def: CommandDef = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'nowhere',
      enabled: () => null,
    };
    expect(() => createRegistry([def], GROUPS, [])).toThrow(/unknown group/);
  });

  it('rejects a menu entry that names no command', () => {
    expect(() => createRegistry([], GROUPS, [['missing']])).toThrow(/no such command/);
  });

  it('rejects a command icon that is not in the bundled set', () => {
    const def = {
      id: 'save',
      labelId: 'command.save.label',
      group: 'home.file',
      enabled: () => null,
      icon: 'no-such-icon',
    } as unknown as CommandDef;
    expect(() => createRegistry([def], GROUPS, [])).toThrow(/unknown icon no-such-icon/);
  });

  it('gives each command its override icon, else the desktop icon from the shared table', () => {
    expect(REGISTRY.icon('whats-different')).toBe('info');
    expect(REGISTRY.icon('save')).toBe('save');
    expect(REGISTRY.icon('undo')).toBe('undo-2');
    expect(REGISTRY.icon('no-such-command')).toBeUndefined();
  });

  it('gives every search keyword an English string', () => {
    const withKeywords = COMMANDS.filter((def) => def.keywordsId !== undefined);
    expect(withKeywords.length).toBeGreaterThanOrEqual(10);
    for (const def of withKeywords) {
      const keywordsId = def.keywordsId as MessageId;
      expect(EN[keywordsId].trim(), def.id).not.toBe('');
    }
  });

  it('has no duplicate ids in the built-in catalogue', () => {
    const ids = COMMANDS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes every shortcut from the shared table, never from the declarations', () => {
    for (const def of REGISTRY.commands) {
      expect(Object.keys(def), def.id).not.toContain('shortcut');
      const expected = isSharedId(def.id) ? SHARED[def.id]?.keys[0] : undefined;
      expect(REGISTRY.shortcut(def.id), def.id).toBe(expected);
    }
    expect(REGISTRY.shortcut('save')).toBe('Ctrl+S');
    expect(REGISTRY.shortcut('undo')).toBe('Ctrl+Z');
  });

  it('splits ids exactly into shared (in the table) and web-only', () => {
    for (const def of COMMANDS) {
      expect(isSharedId(def.id), def.id).toBe(!WEB_ONLY_IDS.has(def.id));
    }
    for (const id of WEB_ONLY_IDS) {
      expect(isSharedId(id), id).toBe(false);
    }
  });

  it('has an English label for every label id, group, tab and reason', () => {
    const ids: MessageId[] = [
      ...COMMANDS.map((def) => def.labelId),
      ...GROUPS.map((group) => group.labelId),
      ...TAB_ORDER.map((tab) => TAB_LABELS[tab]),
      ...Object.values(DISABLED_REASON_LABELS),
      'ribbon.label',
      'appMenu.label',
    ];
    for (const id of ids) {
      expect(EN[id], id).toBeTruthy();
    }
  });

  it('keeps the ribbon in the desktop order, Home first', () => {
    expect(TAB_ORDER).toEqual(['home', 'edit', 'organize', 'protect', 'comment', 'view', 'tools']);
  });
});

describe('open recent', () => {
  it('is disabled while the recent list is empty, and runs once there are files', () => {
    const openRecent = vi.fn();
    expect(runCommand(REGISTRY, 'open-recent', state(), { 'open-recent': openRecent })).toBe(false);
    const withRecent = state({ hasRecentFiles: true });
    expect(runCommand(REGISTRY, 'open-recent', withRecent, { 'open-recent': openRecent })).toBe(
      true,
    );
    expect(openRecent).toHaveBeenCalledTimes(1);
  });

  it('is not a desktop shortcut, so it is web-only', () => {
    expect(WEB_ONLY_IDS.has('open-recent')).toBe(true);
  });
});

describe('visibility and running', () => {
  it('does not run a disabled command, even when a handler exists', () => {
    const save = vi.fn();
    const ran = runCommand(REGISTRY, 'save', state(), { save });
    expect(ran).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('runs an enabled command once with its handler', () => {
    const save = vi.fn();
    expect(runCommand(REGISTRY, 'save', withDoc, { save })).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not run a command with no handler', () => {
    expect(runCommand(REGISTRY, 'save', withDoc, {})).toBe(false);
  });

  it('disables undo and redo by their own state', () => {
    const undo = vi.fn();
    expect(runCommand(REGISTRY, 'undo', withDoc, { undo })).toBe(false);
    expect(runCommand(REGISTRY, 'undo', { ...withDoc, canUndo: true }, { undo })).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('hides a command whose capability is missing, from the ribbon and the menu', () => {
    const without = state({ hasDocument: true });
    const tabs = ribbonLayout(REGISTRY, without);
    const groupIds = tabs.flatMap((tab) => tab.groups.map((group) => group.group.id));
    expect(groupIds).not.toContain('protect.sign');
    expect(groupIds).not.toContain('tools.ocr');
    const menu = menuSections(REGISTRY, without)
      .flat()
      .map((def) => def.id);
    expect(menu).not.toContain('install-app');
    expect(runCommand(REGISTRY, 'sign-document', without, { 'sign-document': vi.fn() })).toBe(
      false,
    );
  });

  it('drops a tab whose groups are all hidden', () => {
    const tabs = ribbonLayout(REGISTRY, state({ hasDocument: true }));
    expect(tabs.map((tab) => tab.tab)).toEqual(TAB_ORDER);
    const onlyPdfa = ribbonLayout(
      createRegistry(
        COMMANDS.filter((def) => def.group === 'tools.standards'),
        GROUPS,
        [],
      ),
      state(),
    );
    expect(onlyPdfa.map((tab) => tab.tab)).toEqual([]);
  });
});

describe('ribbon and menu layouts', () => {
  it('lists each tab group in declaration order with its visible commands', () => {
    const home = ribbonLayout(REGISTRY, withDoc).find((tab) => tab.tab === 'home');
    expect(home?.groups.map((group) => group.group.id)).toEqual([
      'home.file',
      'home.history',
      'home.tools',
      'home.search',
      'home.navigate',
    ]);
    expect(home?.groups[0]?.commands.map((def) => def.id)).toEqual([
      'open',
      'save',
      'print',
      'document-properties',
    ]);
  });

  it('keeps app-menu-only commands out of the ribbon', () => {
    const ribbonIds = ribbonLayout(REGISTRY, withDoc).flatMap((tab) =>
      tab.groups.flatMap((group) => group.commands.map((def) => def.id)),
    );
    for (const id of ['preferences', 'keyboard-shortcuts', 'about-elanero', 'close']) {
      expect(ribbonIds).not.toContain(id);
    }
  });

  it('builds the app menu sections in W1.6 order', () => {
    const sections = menuSections(REGISTRY, withDoc).map((section) => section.map((def) => def.id));
    expect(sections[0]).toEqual([
      'open',
      'open-recent',
      'save',
      'save-as',
      'print',
      'document-properties',
      'close',
    ]);
    expect(sections[1]).toEqual(['preferences', 'keyboard-shortcuts']);
    expect(sections[2]).toEqual(['help', 'whats-different', 'install-app', 'about-elanero']);
    // With every capability on, each declared menu entry shows.
    expect(sections.flat().length).toBe(MENU.flat().length);
  });
});
