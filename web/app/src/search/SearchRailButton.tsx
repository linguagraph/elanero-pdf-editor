// The rail button that opens and closes the search panel (W5.4, W1.6 section 1). The search and the
// thumbnails panels share the right panel, so opening one closes the other.
import { t } from '../i18n/t';
import { setBookmarksOpen } from '../bookmarks/openState';
import { setThumbnailsOpen } from '../thumbnails/openState';
import { setSearchOpen, useSearchOpen } from './openState';
import './search.css';

export interface SearchRailButtonProps {
  readonly tabId: number | null;
  // True when no document is shown, so there is no panel to open.
  readonly disabled: boolean;
}

export function SearchRailButton({ tabId, disabled }: SearchRailButtonProps) {
  const open = useSearchOpen(tabId);
  return (
    <button
      type="button"
      title={t('search.title')}
      className="search-rail-button"
      aria-pressed={open}
      disabled={disabled || tabId === null}
      onClick={() => {
        if (tabId === null) return;
        if (!open) {
          setThumbnailsOpen(tabId, false);
          setBookmarksOpen(tabId, false);
        }
        setSearchOpen(tabId, !open);
      }}
    >
      {t('search.title')}
    </button>
  );
}
