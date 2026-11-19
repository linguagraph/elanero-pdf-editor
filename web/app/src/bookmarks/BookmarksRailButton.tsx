// The rail button that opens and closes the bookmarks panel (W5.2, W1.6 section 1). Its pressed
// state is the panel's open state for the active tab. The right panel shows one panel at a time.
import { t } from '../i18n/t';
import { setOrganizerOpen } from '../organizer/openState';
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
          setOrganizerOpen(tabId, false);
        }
        setBookmarksOpen(tabId, !open);
      }}
    >
      <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
      </svg>
      <span className="visually-hidden">{t('bookmarks.title')}</span>
    </button>
  );
}
