// Visibility, running and the layouts the ribbon and app menu draw (W1.6 sections 2 and 6). All
// of it reads the registry and the caller's state; nothing here touches the engine.
import {
  TAB_ORDER,
  type CommandDef,
  type CommandState,
  type DisabledReason,
  type GroupDef,
  type Registry,
  type TabId,
} from './registry';

// The handler the caller passes for each command id. A command with no handler does nothing.
export type CommandHandlers = Readonly<Record<string, (() => void) | undefined>>;

// Hidden means the capability is off (W1.6 section 2): the command is absent, not greyed.
export function isVisible(def: CommandDef, state: CommandState): boolean {
  return def.capability === undefined || state.capabilities.has(def.capability);
}

// Why a command cannot run now, or null when it can. A command with no handler yet reads as
// disabled, so the ribbon and the menu never show a command that does nothing as enabled.
export function commandDisabledReason(
  def: CommandDef,
  state: CommandState,
  handlers: CommandHandlers,
): DisabledReason | null {
  const reason = def.enabled(state);
  if (reason !== null) return reason;
  return handlers[def.id] === undefined ? 'notAvailableYet' : null;
}

// Runs the command when it is visible, enabled and has a handler. Returns whether it ran, so a
// disabled command never runs even if something calls it directly.
export function runCommand(
  registry: Registry,
  id: string,
  state: CommandState,
  handlers: CommandHandlers,
): boolean {
  const def = registry.get(id);
  if (def === undefined || !isVisible(def, state) || def.enabled(state) !== null) return false;
  const handler = handlers[id];
  if (handler === undefined) return false;
  handler();
  return true;
}

export interface RibbonGroup {
  readonly group: GroupDef;
  readonly commands: readonly CommandDef[];
}

export interface RibbonTab {
  readonly tab: TabId;
  readonly groups: readonly RibbonGroup[];
}

// The ribbon's tabs in the desktop order. A group whose commands are all hidden is dropped, and a
// tab left with no groups is dropped too (W1.6 section 2).
export function ribbonLayout(registry: Registry, state: CommandState): RibbonTab[] {
  return TAB_ORDER.flatMap((tab) => {
    const groups = registry.groups
      .filter((group) => group.tab === tab)
      .map((group) => ({
        group,
        commands: registry.commands.filter(
          (def) => def.group === group.id && isVisible(def, state),
        ),
      }))
      .filter((entry) => entry.commands.length > 0);
    return groups.length > 0 ? [{ tab, groups }] : [];
  });
}

// The app menu's sections with hidden commands removed; an empty section is dropped.
export function menuSections(registry: Registry, state: CommandState): CommandDef[][] {
  return registry.menu
    .map((ids) =>
      ids
        .map((id) => registry.get(id))
        .filter((def): def is CommandDef => def !== undefined && isVisible(def, state)),
    )
    .filter((section) => section.length > 0);
}
