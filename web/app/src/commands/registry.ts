// The command registry (W1.6 sections 2, 6 and 9, W4.3a). Every ribbon and app-menu command is
// declared once, in catalog.ts, and read from here. A command's id is the desktop's action id
// (ui/shortcuts.py `action_id`), so its shortcut and label line up with the desktop's. The shortcut
// is read from the shared table (web/src/generated/shortcuts.json, written by
// scripts/make_shortcut_docs.py), never typed in here. Nothing in this module does PDF work or
// calls the engine: a command runs a handler the caller passes in (see run.ts).
import shortcutTable from '../../../src/generated/shortcuts.json';
import type { MessageId } from '../i18n/en';
import { ICONS, type IconName } from '../theme/icons.generated';

export const TAB_ORDER = [
  'home',
  'edit',
  'organize',
  'protect',
  'comment',
  'view',
  'tools',
] as const;
export type TabId = (typeof TAB_ORDER)[number];

export const TAB_LABELS: Readonly<Record<TabId, MessageId>> = {
  home: 'ribbon.tab.home',
  edit: 'ribbon.tab.edit',
  organize: 'ribbon.tab.organize',
  protect: 'ribbon.tab.protect',
  comment: 'ribbon.tab.comment',
  view: 'ribbon.tab.view',
  tools: 'ribbon.tab.tools',
};

// A capability the web build may lack (W1.1 section 3). A command that needs one is hidden, not
// greyed, when the capability is missing.
export const CAPABILITIES = ['signing', 'ocr', 'office_import', 'pdfa', 'pwa_install'] as const;
export type Capability = (typeof CAPABILITIES)[number];

// What the enabled predicates read. The caller builds it from its own state; this module has no
// link to the engine or to the document.
export interface CommandState {
  readonly hasDocument: boolean;
  // True when the recent-files list has at least one name (W4.2b).
  readonly hasRecentFiles: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly capabilities: ReadonlySet<Capability>;
  // The ribbon's own choices (W4.3a S2): the user's, not the form the width forces.
  readonly ribbonCompact: boolean;
  readonly ribbonCollapsed: boolean;
}

// notAvailableYet is not an enabled rule: the caller reports it when a command has no handler.
export type DisabledReason =
  'needsDocument' | 'nothingToUndo' | 'nothingToRedo' | 'noRecentFiles' | 'notAvailableYet';

export const DISABLED_REASON_LABELS: Readonly<Record<DisabledReason, MessageId>> = {
  needsDocument: 'disabled.needsDocument',
  nothingToUndo: 'disabled.nothingToUndo',
  nothingToRedo: 'disabled.nothingToRedo',
  noRecentFiles: 'disabled.noRecentFiles',
  notAvailableYet: 'disabled.notAvailableYet',
};

// Returns the reason a command is disabled, or null when it can run.
export type Enabled = (state: CommandState) => DisabledReason | null;

export const ALWAYS: Enabled = () => null;
export const NEEDS_DOCUMENT: Enabled = (state) => (state.hasDocument ? null : 'needsDocument');
export const CAN_UNDO: Enabled = (state) => (state.canUndo ? null : 'nothingToUndo');
export const CAN_REDO: Enabled = (state) => (state.canRedo ? null : 'nothingToRedo');
export const HAS_RECENT: Enabled = (state) => (state.hasRecentFiles ? null : 'noRecentFiles');

// A ribbon group (tab `null` marks a group that only the app menu uses).
export interface GroupDef {
  readonly id: string;
  readonly tab: TabId | null;
  readonly labelId: MessageId;
}

export interface CommandDef {
  readonly id: string;
  readonly labelId: MessageId;
  readonly group: string;
  readonly enabled: Enabled;
  readonly capability?: Capability;
  // Set only for an id the shared table has no icon for (web-only ids, and desktop commands with no
  // icon); otherwise the desktop icon name from the shared table applies.
  readonly icon?: IconName;
  // Search aliases (W4.3b D3): the palette also matches words in this message. Never shown.
  readonly keywordsId?: MessageId;
  // A toggle's state (W1.6 section 9): true when the command's option is on.
  readonly checked?: (state: CommandState) => boolean;
}

export interface Registry {
  readonly commands: readonly CommandDef[];
  readonly groups: readonly GroupDef[];
  // The app menu's sections, in order; each lists command ids in display order.
  readonly menu: readonly (readonly string[])[];
  get(id: string): CommandDef | undefined;
  // The default shortcut from the shared table, or undefined when the command has none.
  shortcut(id: string): string | undefined;
  // The command's icon: the override, else the shared table's desktop icon when the web has it.
  icon(id: string): IconName | undefined;
}

interface ShortcutEntry {
  readonly keys: readonly string[];
  // The desktop icon name, or null when the desktop command has none.
  readonly icon: string | null;
}

// The shared table: desktop command id -> label and default key sequences.
const SHARED_SHORTCUTS: Readonly<Record<string, ShortcutEntry>> = shortcutTable.commands;

// Whether a name is one of the bundled icons (the web build ships the whole desktop set).
export function isIconName(name: string): name is IconName {
  return Object.hasOwn(ICONS, name);
}

// Whether the shared table lists this id (the desktop has the command).
export function isSharedId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(SHARED_SHORTCUTS, id);
}

// The shared table's key strings for a command, in the desktop's order (none when it has none).
export function sharedKeys(id: string): readonly string[] {
  return isSharedId(id) ? (SHARED_SHORTCUTS[id]?.keys ?? []) : [];
}

// Builds a registry, and throws on a declaration error: a duplicate id, a command in an unknown
// group, or a menu entry that names no command. Failing at start-up beats a silent mis-wire.
export function createRegistry(
  commands: readonly CommandDef[],
  groups: readonly GroupDef[],
  menu: readonly (readonly string[])[],
): Registry {
  const byId = new Map<string, CommandDef>();
  for (const def of commands) {
    if (byId.has(def.id)) throw new Error(`duplicate command id: ${def.id}`);
    byId.set(def.id, def);
  }
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (groupIds.has(group.id)) throw new Error(`duplicate group id: ${group.id}`);
    groupIds.add(group.id);
  }
  for (const def of commands) {
    if (!groupIds.has(def.group)) throw new Error(`command ${def.id}: unknown group ${def.group}`);
  }
  for (const def of commands) {
    if (def.icon !== undefined && !isIconName(def.icon)) {
      throw new Error(`command ${def.id}: unknown icon ${String(def.icon)}`);
    }
  }
  for (const section of menu) {
    for (const id of section) {
      if (!byId.has(id)) throw new Error(`menu entry ${id}: no such command`);
    }
  }
  return {
    commands,
    groups,
    menu,
    get: (id) => byId.get(id),
    shortcut: (id) => (isSharedId(id) ? SHARED_SHORTCUTS[id]?.keys[0] : undefined),
    icon: (id) => {
      const override = byId.get(id)?.icon;
      if (override !== undefined) return override;
      const shared = isSharedId(id) ? SHARED_SHORTCUTS[id]?.icon : null;
      return shared !== null && shared !== undefined && isIconName(shared) ? shared : undefined;
    },
  };
}
