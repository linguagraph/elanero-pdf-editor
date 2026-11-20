import { Button, Menu, MenuItem, MenuTrigger, Popover, Separator } from 'react-aria-components';
import { t } from '../i18n/t';
import type { TabState } from './tabState';
import './tabs.css';

export interface DocumentTabMenuProps {
  readonly state: TabState;
  onSelect(id: number): void;
  onClose(id: number): void;
}

// The open documents as a drop-down, for the tablet and phone tiers (W1.6 section 8), where the
// tab strip would not fit beside the ribbon. The button shows the active document; the list holds
// every open document, and a close item for the active one. react-aria closes the list on Escape
// and on a press outside, and returns focus to the button.
export function DocumentTabMenu({ state, onSelect, onClose }: DocumentTabMenuProps) {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  const closeKey = 'close';
  // The accessible name carries the active document and its unsaved state: a name on the button
  // replaces its content for assistive technology, so the marker has to be in the name too.
  const accessibleName =
    active === undefined
      ? t('tabs.menu')
      : t('tabs.menuNamed', {
          name: active.dirty ? `${active.name} (${t('tabs.unsaved')})` : active.name,
        });
  return (
    <div className="doc-tabs-menu">
      <MenuTrigger>
        <Button className="doc-tabs-menu-button" aria-label={accessibleName}>
          <span className="doc-tab-name">{active?.name ?? ''}</span>
          {active?.dirty ? (
            <span className="doc-tab-dirty">
              <span aria-hidden="true">•</span>
              <span className="visually-hidden">{t('tabs.unsaved')}</span>
            </span>
          ) : null}
          <span aria-hidden="true" className="doc-tabs-menu-caret">
            ▾
          </span>
        </Button>
        <Popover className="app-menu-popover">
          <Menu
            aria-label={t('tabs.menu')}
            className="app-menu"
            selectionMode="single"
            selectedKeys={active === undefined ? [] : [String(active.id)]}
            onAction={(key) => {
              if (key === closeKey) {
                if (active !== undefined) onClose(active.id);
                return;
              }
              onSelect(Number(key));
            }}
          >
            {state.tabs.map((tab) => (
              <MenuItem
                key={tab.id}
                id={String(tab.id)}
                textValue={tab.name}
                className="app-menu-item"
              >
                <span className="doc-tab-name">{tab.name}</span>
                {tab.dirty ? (
                  <span className="doc-tab-dirty">
                    <span aria-hidden="true">•</span>
                    <span className="visually-hidden">{t('tabs.unsaved')}</span>
                  </span>
                ) : null}
              </MenuItem>
            ))}
            {active !== undefined ? <Separator className="app-menu-separator" /> : null}
            {active !== undefined ? (
              <MenuItem id={closeKey} textValue={t('tabs.menuClose')} className="app-menu-item">
                {t('tabs.menuClose')}
              </MenuItem>
            ) : null}
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}
