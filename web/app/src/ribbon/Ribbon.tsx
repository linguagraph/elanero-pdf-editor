import { useId, useState } from 'react';
import { Button, Tab, TabList, TabPanel, Tabs, Toolbar } from 'react-aria-components';
import { type CommandHandlers, ribbonLayout, runCommand } from '../commands/run';
import {
  type CommandDef,
  type CommandState,
  DISABLED_REASON_LABELS,
  type Registry,
  TAB_LABELS,
  type TabId,
} from '../commands/registry';
import { t } from '../i18n/t';
import './ribbon.css';

export interface RibbonProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

// The ribbon (W1.6 section 2): the desktop's tabs in order, with the groups each tab shows. Tabs and
// the commands are react-aria widgets, so arrow keys move between tabs and between commands, and
// Tab leaves the ribbon. A disabled command stays in the ribbon with aria-disabled and the reason
// as its description; running it does nothing.
export function Ribbon({ registry, state, handlers }: RibbonProps) {
  const tabs = ribbonLayout(registry, state);
  const [selected, setSelected] = useState<TabId>('home');
  // Show the first tab when the selected one has no groups in this state (for example, Tools
  // with every command hidden).
  const current = tabs.find((entry) => entry.tab === selected)?.tab ?? tabs[0]?.tab;

  return (
    <Tabs
      className="ribbon"
      selectedKey={current}
      onSelectionChange={(key) => setSelected(String(key) as TabId)}
    >
      <TabList aria-label={t('ribbon.label')} className="ribbon-tabs">
        {tabs.map((entry) => (
          <Tab key={entry.tab} id={entry.tab} className="ribbon-tab">
            {t(TAB_LABELS[entry.tab])}
          </Tab>
        ))}
      </TabList>
      {tabs.map((entry) => (
        <TabPanel key={entry.tab} id={entry.tab} className="ribbon-panel">
          <Toolbar aria-label={t('ribbon.label')} className="ribbon-toolbar">
            {entry.groups.map((group) => (
              <RibbonGroup
                key={group.group.id}
                label={t(group.group.labelId)}
                commands={group.commands}
                registry={registry}
                state={state}
                handlers={handlers}
              />
            ))}
          </Toolbar>
        </TabPanel>
      ))}
    </Tabs>
  );
}

interface RibbonGroupProps {
  label: string;
  commands: readonly CommandDef[];
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

function RibbonGroup({ label, commands, registry, state, handlers }: RibbonGroupProps) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="ribbon-group">
      <div className="ribbon-group-commands">
        {commands.map((def) => (
          <CommandButton
            key={def.id}
            def={def}
            registry={registry}
            state={state}
            handlers={handlers}
          />
        ))}
      </div>
      <span id={labelId} className="ribbon-group-label">
        {label}
      </span>
    </div>
  );
}

interface CommandButtonProps {
  def: CommandDef;
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

function CommandButton({ def, registry, state, handlers }: CommandButtonProps) {
  const reason = def.enabled(state);
  const reasonId = useId();
  const shortcutId = useId();
  const shortcut = registry.shortcut(def.id);
  const reasonText = reason === null ? undefined : t(DISABLED_REASON_LABELS[reason]);
  // The reason (when disabled) and the shortcut are described by hidden text, because react-aria's
  // Button does not pass a title or aria-keyshortcuts through.
  const describedBy = [reasonText === undefined ? null : reasonId, shortcut ? shortcutId : null]
    .filter((id): id is string => id !== null)
    .join(' ');
  return (
    <>
      <Button
        className="ribbon-command"
        data-command={def.id}
        aria-disabled={reasonText === undefined ? undefined : 'true'}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onPress={() => {
          runCommand(registry, def.id, state, handlers);
        }}
      >
        {t(def.labelId)}
      </Button>
      {reasonText === undefined ? null : (
        <span id={reasonId} hidden>
          {reasonText}
        </span>
      )}
      {shortcut === undefined ? null : (
        <span id={shortcutId} hidden>
          {shortcut}
        </span>
      )}
    </>
  );
}
