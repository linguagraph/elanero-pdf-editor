import { Fragment } from 'react';
import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import { type CommandHandlers, menuSections, runCommand } from '../commands/run';
import { type CommandState, type Registry } from '../commands/registry';
import { t } from '../i18n/t';
import './ribbon.css';

export interface AppMenuProps {
  registry: Registry;
  state: CommandState;
  handlers: CommandHandlers;
}

// The app menu (W1.6 section 6), opened by the ☰ button. react-aria closes it on Escape and on a
// press outside, and returns focus to the button. A disabled item is aria-disabled and does not
// run.
export function AppMenu({ registry, state, handlers }: AppMenuProps) {
  const sections = menuSections(registry, state);
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
            runCommand(registry, String(key), state, handlers);
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
                  isDisabled={def.enabled(state) !== null}
                  textValue={t(def.labelId)}
                >
                  {t(def.labelId)}
                </MenuItem>
              ))}
            </Fragment>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
