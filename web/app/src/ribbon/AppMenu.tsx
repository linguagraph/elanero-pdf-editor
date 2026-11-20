import { Fragment } from 'react';
import {
  Button,
  Header,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Section,
  Separator,
} from 'react-aria-components';
import {
  type CommandHandlers,
  commandDisabledReason,
  menuSections,
  runCommand,
} from '../commands/run';
import { type CommandState, type Registry } from '../commands/registry';
import { t } from '../i18n/t';
import './ribbon.css';

// A side panel the menu opens on a narrow window, where the left rail is hidden (W4.2a S7b).
export interface AppMenuPanelItem {
  readonly id: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onAction: () => void;
}

export interface AppMenuProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
  // Given only when the left rail is hidden; the menu then lists the panels in a "Panels" section.
  readonly panelItems?: readonly AppMenuPanelItem[];
}

// Panel keys share the menu's key space with the commands, so they carry this prefix.
const PANEL_KEY = 'panel:';

// The app menu (W1.6 section 6), opened by the ☰ button. react-aria closes it on Escape and on a
// press outside, and returns focus to the button. A disabled item is aria-disabled and does not
// run.
export function AppMenu({ registry, state, handlers, panelItems }: AppMenuProps) {
  const sections = menuSections(registry, state);
  const panels = panelItems ?? [];
  return (
    <MenuTrigger>
      <Button aria-label={t('appMenu.label')} className="app-menu-button">
        ☰
      </Button>
      <Popover className="app-menu-popover">
        <Menu
          aria-label={t('appMenu.label')}
          className="app-menu"
          onAction={(key) => {
            const id = String(key);
            if (id.startsWith(PANEL_KEY)) {
              panels.find((item) => PANEL_KEY + item.id === id)?.onAction();
              return;
            }
            runCommand(registry, id, state, handlers);
          }}
        >
          {sections.map((section, index) => (
            <Fragment key={section[0]?.id ?? index}>
              {index > 0 ? <Separator className="app-menu-separator" /> : null}
              {section.map((def) => (
                <MenuItem
                  key={def.id}
                  id={def.id}
                  className="app-menu-item"
                  isDisabled={commandDisabledReason(def, state, handlers) !== null}
                  textValue={t(def.labelId)}
                >
                  {t(def.labelId)}
                </MenuItem>
              ))}
            </Fragment>
          ))}
          {panels.length > 0 ? (
            <Fragment>
              <Separator className="app-menu-separator" />
              <Section>
                <Header className="app-menu-heading">{t('appMenu.panels')}</Header>
                {panels.map((item) => (
                  <MenuItem
                    key={PANEL_KEY + item.id}
                    id={PANEL_KEY + item.id}
                    className="app-menu-item"
                    isDisabled={item.disabled}
                    textValue={item.label}
                  >
                    {item.label}
                  </MenuItem>
                ))}
              </Section>
            </Fragment>
          ) : null}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
