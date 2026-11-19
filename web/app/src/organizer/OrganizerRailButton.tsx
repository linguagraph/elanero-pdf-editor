// The rail button that opens and closes the page organizer (W6.1). Its pressed state is the
// panel's open state for the active tab. Opening it closes the thumbnails and search panels, since
// one right panel shows at a time.
import { t } from '../i18n/t';
import { setBookmarksOpen } from '../bookmarks/openState';
import { setSearchOpen } from '../search/openState';
import { setThumbnailsOpen } from '../thumbnails/openState';
import { setOrganizerOpen, useOrganizerOpen } from './openState';
import './organizer.css';

export interface OrganizerRailButtonProps {
  readonly tabId: number | null;
  // True when no document is shown, so there is no panel to open.
  readonly disabled: boolean;
}

export function OrganizerRailButton({ tabId, disabled }: OrganizerRailButtonProps) {
  const open = useOrganizerOpen(tabId);
  return (
    <button
      type="button"
      className="organizer-rail-button"
      aria-pressed={open}
      disabled={disabled || tabId === null}
      onClick={() => {
        if (tabId === null) return;
        setThumbnailsOpen(tabId, false);
        setSearchOpen(tabId, false);
        setBookmarksOpen(tabId, false);
        setOrganizerOpen(tabId, !open);
      }}
    >
      {t('organizer.title')}
    </button>
  );
}
