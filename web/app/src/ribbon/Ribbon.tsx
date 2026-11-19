import { useId, useState } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Popover,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Toolbar,
} from 'react-aria-components';
import {
  type CommandHandlers,
  commandDisabledReason,
  type RibbonTab,
  ribbonLayout,
  runCommand,
} from '../commands/run';
import {
  type CommandDef,
  type CommandState,
  DISABLED_REASON_LABELS,
  type Registry,
  TAB_LABELS,
  type TabId,
} from '../commands/registry';
import { t } from '../i18n/t';
import { useLayoutRegions } from '../layout/LayoutContext';
import { Icon } from '../theme/Icon';
import './ribbon.css';

export interface RibbonProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

// The ribbon (W1.6 section 2) picks its form from the window width: the full ribbon above the
// tablet breakpoint, and the collapsed form below it (a phone, W4.2a), where the groups open from
// the tabs.
export function Ribbon(props: RibbonProps) {
  const collapsed = useLayoutRegions().tier === 'phone';
  return collapsed ? <CollapsedRibbon {...props} /> : <FullRibbon {...props} />;
}

// The full ribbon: the desktop's tabs in order, with the groups each tab shows. Tabs and the
// commands are react-aria widgets, so arrow keys move between tabs and between commands, and Tab
// leaves the ribbon. A disabled command stays in the ribbon with aria-disabled and the reason as
// its description; running it does nothing.
function FullRibbon({ registry, state, handlers }: RibbonProps) {
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

// The collapsed form: one row of tab buttons. A tab opens its groups in a popover, which closes
// once a command in it runs (W1.6 section 2).
function CollapsedRibbon({ registry, state, handlers }: RibbonProps) {
  const tabs = ribbonLayout(registry, state);
  return (
    <div className="ribbon ribbon-collapsed">
      <div className="ribbon-tabs" role="group" aria-label={t('ribbon.label')}>
        {tabs.map((entry) => (
          <DialogTrigger key={entry.tab}>
            <Button className="ribbon-tab" aria-haspopup="dialog">
              {t(TAB_LABELS[entry.tab])}
            </Button>
            <Popover className="ribbon-popover" placement="bottom start">
              <Dialog className="ribbon-popover-body" aria-label={t(TAB_LABELS[entry.tab])}>
                {({ close }) => (
                  <CollapsedTabBody
                    tab={entry}
                    registry={registry}
                    state={state}
                    handlers={handlers}
                    close={close}
                  />
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        ))}
      </div>
    </div>
  );
}

interface CollapsedTabBodyProps {
  tab: RibbonTab;
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
  close: () => void;
}

// The groups of one tab in the collapsed popover. A press on a disabled command keeps the popover
// open and states the reason in the status line below the groups.
function CollapsedTabBody({ tab, registry, state, handlers, close }: CollapsedTabBodyProps) {
  const [notice, setNotice] = useState('');
  return (
    <>
      {tab.groups.map((group) => (
        <RibbonGroup
          key={group.group.id}
          label={t(group.group.labelId)}
          commands={group.commands}
          registry={registry}
          state={state}
          handlers={handlers}
          onRun={close}
          onBlocked={setNotice}
        />
      ))}
      <p role="status" className="ribbon-notice">
        {notice}
      </p>
    </>
  );
}

interface RibbonGroupProps {
  label: string;
  commands: readonly CommandDef[];
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
  // Called after a command in the group runs (the collapsed form closes its popover with it).
  onRun?: () => void;
  // Called with the reason when a disabled command is pressed.
  onBlocked?: (reason: string) => void;
}

function RibbonGroup({
  label,
  commands,
  registry,
  state,
  handlers,
  onRun,
  onBlocked,
}: RibbonGroupProps) {
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
            onRun={onRun}
            onBlocked={onBlocked}
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
  onRun?: () => void;
  onBlocked?: (reason: string) => void;
}

function CommandButton({ def, registry, state, handlers, onRun, onBlocked }: CommandButtonProps) {
  const reason = commandDisabledReason(def, state, handlers);
  const reasonId = useId();
  const shortcutId = useId();
  const shortcut = registry.shortcut(def.id);
  const icon = registry.icon(def.id);
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
          if (reasonText !== undefined) {
            onBlocked?.(reasonText);
            return;
          }
          if (runCommand(registry, def.id, state, handlers)) onRun?.();
        }}
      >
        {icon === undefined ? null : <Icon name={icon} size={20} />}
        <span className="ribbon-command-label">{t(def.labelId)}</span>
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
