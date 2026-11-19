// The rail button that opens and closes the thumbnails panel (W5.2, W1.6 section 1). Its pressed
// state is the panel's open state for the active tab.
import { t } from '../i18n/t';
import { setBookmarksOpen } from '../bookmarks/openState';
import { setSearchOpen } from '../search/openState';
import { setThumbnailsOpen, useThumbnailsOpen } from './openState';
import './thumbnails.css';

export interface ThumbnailsRailButtonProps {
  readonly tabId: number | null;
  // True when no document is shown, so there is no panel to open.
  readonly disabled: boolean;
}

export function ThumbnailsRailButton({ tabId, disabled }: ThumbnailsRailButtonProps) {
  const open = useThumbnailsOpen(tabId);
  return (
    <button
      type="button"
      className="thumbs-rail-button"
      aria-pressed={open}
      disabled={disabled || tabId === null}
      onClick={() => {
        if (tabId === null) return;
        // The search and thumbnails panels share the right panel: opening one closes the other.
        if (!open) {
          setSearchOpen(tabId, false);
          setBookmarksOpen(tabId, false);
        }
        setThumbnailsOpen(tabId, !open);
      }}
    >
      {t('thumbnails.title')}
    </button>
  );
}
