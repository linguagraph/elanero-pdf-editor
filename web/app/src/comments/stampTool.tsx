// The stamp menu (W7.3 S6): the standard stamps, chosen from a menu beside the comment toolbar.
// Choosing one makes the stamp tool the active comment tool; a click on a page then places that
// stamp (CommentLayer). The menu is react-aria's, so arrows, Enter, typeahead and Escape work.
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components';
import { t } from '../i18n/t';
import { STAMP_LABEL, STANDARD_STAMPS, type StandardStamp } from './stamps';

export interface StampMenuProps {
  readonly onChoose: (stamp: StandardStamp) => void;
}

export function StampMenu({ onChoose }: StampMenuProps) {
  return (
    <MenuTrigger>
      <Button className="stamp-menu-button">{t('stamp.menu')}</Button>
      <Popover className="app-menu-popover">
        <Menu
          aria-label={t('stamp.menuLabel')}
          className="app-menu"
          onAction={(key) => onChoose(String(key) as StandardStamp)}
        >
          {STANDARD_STAMPS.map((name) => (
            <MenuItem key={name} id={name} className="app-menu-item">
              {t(STAMP_LABEL[name])}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
