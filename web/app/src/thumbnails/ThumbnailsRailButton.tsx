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
      title={t('thumbnails.title')}
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
      <svg className="rail-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20 7h-3a2 2 0 0 1-2-2V2" />
        <path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z" />
        <path d="M3 7.6v12.8A2 2 0 0 0 5 22h9.8" />
      </svg>
      <span className="visually-hidden">{t('thumbnails.title')}</span>
    </button>
  );
}
