import { type KeyboardEvent, type MouseEvent, useId, useRef, useState } from 'react';
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
  Tooltip,
  TooltipTrigger,
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
import { displayKeys, effectiveKeys, isMacPlatform } from '../commands/shortcuts';
import { t } from '../i18n/t';
import { layoutTierForWidth } from '../layout/breakpoints';
import { useViewportWidth } from '../layout/useViewportWidth';
import { Icon } from '../theme/Icon';
import { type RibbonForm, ribbonForm } from './form';
import './ribbon.css';

export interface RibbonProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

const IS_MAC = isMacPlatform(navigator.platform);
// A second press within this window is the second half of a double-click (desktop 500 ms).
const DOUBLE_CLICK_MS = 500;
// How long the pointer rests on a command before its tooltip shows (compact form).
const TOOLTIP_DELAY_MS = 400;

// The ribbon's form (W1.6 section 8, W4.3a S2): the window's width sets it, and the user's own
// compact and collapse choices apply on top (ribbon/form.ts holds the table). A tier-collapsed
// ribbon opens its groups from the tabs; every other form is the tab row with its panels.
export function Ribbon(props: RibbonProps) {
  const width = useViewportWidth();
  const form = ribbonForm(layoutTierForWidth(width), {
    compact: props.state.ribbonCompact,
    collapsed: props.state.ribbonCollapsed,
  });
  return form.collapsedBy === 'tier' ? (
    <CollapsedRibbon {...props} />
  ) : (
    <FullRibbon {...props} form={form} />
  );
}

// Whether a press landed on a tab.
function isTabTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="tab"]') !== null;
}

interface FullRibbonProps extends RibbonProps {
  form: RibbonForm;
}

// The full and compact ribbon, and the user-collapsed tab row: the desktop's tabs in order, with
// the groups each tab shows. Tabs and the commands are react-aria widgets, so arrow keys move
// between tabs and between commands, and Tab leaves the ribbon. A disabled command stays in the
// ribbon with aria-disabled and the reason as its description; running it does nothing.
function FullRibbon({ registry, state, handlers, form }: FullRibbonProps) {
  const tabs = ribbonLayout(registry, state);
  const [selected, setSelected] = useState<TabId>('home');
  // Show the first tab when the selected one has no groups in this state (for example, Tools
  // with every command hidden).
  const current = tabs.find((entry) => entry.tab === selected)?.tab ?? tabs[0]?.tab;
  const compact = form.kind === 'compact';
  const userCollapsed = form.collapsedBy === 'user';
  // When the last press expanded the ribbon, the double-click that press began must not collapse
  // it again (desktop _tab_double_clicked).
  const lastExpandRef = useRef(0);

  function toggleRibbon(): void {
    runCommand(registry, 'collapse-ribbon', state, handlers);
  }

  // Touch has no double-click, so the chevron is the touch path. Listening on the row finds the
  // tab with closest(), because react-aria's Tab does not pass click handlers through. The capture
  // phase is used because react-aria stops a press from bubbling past the tab.
  function onRowClick(event: MouseEvent<HTMLDivElement>): void {
    if (!userCollapsed || !isTabTarget(event.target)) return;
    lastExpandRef.current = Date.now();
    toggleRibbon();
  }

  function onRowDoubleClick(event: MouseEvent<HTMLDivElement>): void {
    if (!isTabTarget(event.target)) return;
    if (Date.now() - lastExpandRef.current < DOUBLE_CLICK_MS) return;
    toggleRibbon();
  }

  // Keyboard path: react-aria's Tab does not dispatch a DOM click for Enter or Space, so a
  // collapsed ribbon would never expand from the keyboard. Handled in the capture phase, as the
  // click is.
  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!userCollapsed || !isTabTarget(event.target)) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleRibbon();
  }

  return (
    <Tabs
      className="ribbon"
      data-form={form.kind}
      data-collapsed-by={form.collapsedBy ?? undefined}
      selectedKey={current}
      onSelectionChange={(key) => setSelected(String(key) as TabId)}
    >
      <div
        className="ribbon-tabrow"
        onClickCapture={onRowClick}
        onDoubleClickCapture={onRowDoubleClick}
        onKeyDownCapture={onRowKeyDown}
      >
        <TabList aria-label={t('ribbon.label')} className="ribbon-tabs">
          {tabs.map((entry) => (
            <Tab key={entry.tab} id={entry.tab} className="ribbon-tab">
              {t(TAB_LABELS[entry.tab])}
            </Tab>
          ))}
        </TabList>
        <CollapseChevron expanded={!userCollapsed} onPress={toggleRibbon} />
      </div>
      {userCollapsed
        ? null
        : tabs.map((entry) => (
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
                    compact={compact}
                  />
                ))}
              </Toolbar>
            </TabPanel>
          ))}
    </Tabs>
  );
}

interface CollapseChevronProps {
  // True while the ribbon shows its panels (the chevron then collapses it).
  expanded: boolean;
  onPress: () => void;
}

// The chevron at the tab row's end: it collapses or shows the ribbon. Its tooltip names the
// effective Ctrl+F1 keys, so an override from the shortcut settings shows up.
function CollapseChevron({ expanded, onPress }: CollapseChevronProps) {
  const keys = effectiveKeys('collapse-ribbon');
  const label = expanded ? t('ribbon.collapse') : t('ribbon.expand');
  const tip =
    expanded && keys.length > 0
      ? t('ribbon.collapseTip', { keys: displayKeys(keys, IS_MAC) })
      : label;
  return (
    <TooltipTrigger delay={TOOLTIP_DELAY_MS}>
      <Button className="ribbon-chevron" aria-label={label} onPress={onPress}>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
      </Button>
      <Tooltip className="ribbon-tooltip">{tip}</Tooltip>
    </TooltipTrigger>
  );
}

// The collapsed form: one row of tab buttons. A tab opens its groups in a popover, which closes
// once a command in it runs (W1.6 section 2).
function CollapsedRibbon({ registry, state, handlers }: RibbonProps) {
  const tabs = ribbonLayout(registry, state);
  return (
    <div className="ribbon ribbon-collapsed" data-form="collapsed" data-collapsed-by="tier">
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
  // The compact form hides the caption, which still names the group for assistive technology.
  compact?: boolean;
}

function RibbonGroup({
  label,
  commands,
  registry,
  state,
  handlers,
  onRun,
  onBlocked,
  compact = false,
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
            compact={compact}
          />
        ))}
      </div>
      <span
        id={labelId}
        className={compact ? 'ribbon-group-label ribbon-visually-hidden' : 'ribbon-group-label'}
      >
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
  compact: boolean;
}

function CommandButton({
  def,
  registry,
  state,
  handlers,
  onRun,
  onBlocked,
  compact,
}: CommandButtonProps) {
  const reason = commandDisabledReason(def, state, handlers);
  const reasonId = useId();
  const shortcutId = useId();
  const shortcut = registry.shortcut(def.id);
  const icon = registry.icon(def.id);
  const label = t(def.labelId);
  const reasonText = reason === null ? undefined : t(DISABLED_REASON_LABELS[reason]);
  // The reason (when disabled) and the shortcut are described by hidden text, because react-aria's
  // Button does not pass a title or aria-keyshortcuts through.
  const describedBy = [reasonText === undefined ? null : reasonId, shortcut ? shortcutId : null]
    .filter((id): id is string => id !== null)
    .join(' ');
  // A compact command with an icon shows only the icon, so its label is the accessible name and
  // the tooltip. A command with no icon keeps its label as text.
  const iconOnly = compact && icon !== undefined;
  const button = (
    <Button
      className="ribbon-command"
      data-command={def.id}
      aria-label={iconOnly ? label : undefined}
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
      {iconOnly ? null : <span className="ribbon-command-label">{label}</span>}
    </Button>
  );
  const tip = shortcut === undefined ? label : t('ribbon.commandTip', { label, keys: shortcut });
  return (
    <>
      {iconOnly ? (
        <TooltipTrigger delay={TOOLTIP_DELAY_MS}>
          {button}
          <Tooltip className="ribbon-tooltip">{tip}</Tooltip>
        </TooltipTrigger>
      ) : (
        button
      )}
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
