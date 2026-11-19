// The rail button that opens and closes the bookmarks panel (W5.2, W1.6 section 1). Its pressed
// state is the panel's open state for the active tab. The right panel shows one panel at a time.
import { t } from '../i18n/t';
import { setSearchOpen } from '../search/openState';
import { setThumbnailsOpen } from '../thumbnails/openState';
import { setBookmarksOpen, useBookmarksOpen } from './openState';
import './bookmarks.css';

export interface BookmarksRailButtonProps {
  readonly tabId: number | null;
  // True when no document is shown, so there is no panel to open.
  readonly disabled: boolean;
}

export function BookmarksRailButton({ tabId, disabled }: BookmarksRailButtonProps) {
  const open = useBookmarksOpen(tabId);
  return (
    <button
      type="button"
      title={t('bookmarks.title')}
      className="bookmarks-rail-button"
      aria-pressed={open}
      disabled={disabled || tabId === null}
      onClick={() => {
        if (tabId === null) return;
        if (!open) {
          setThumbnailsOpen(tabId, false);
          setSearchOpen(tabId, false);
        }
        setBookmarksOpen(tabId, !open);
      }}
    >
      {t('bookmarks.title')}
    </button>
  );
}
