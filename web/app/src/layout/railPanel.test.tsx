import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookmarksRailButton } from '../bookmarks/BookmarksRailButton';
import { isBookmarksOpen } from '../bookmarks/openState';
import { OrganizerRailButton } from '../organizer/OrganizerRailButton';
import { isOrganizerOpen } from '../organizer/openState';
import { t } from '../i18n/t';
import { SearchRailButton } from '../search/SearchRailButton';
import { isSearchOpen } from '../search/openState';
import { ThumbnailsRailButton } from '../thumbnails/ThumbnailsRailButton';
import { isThumbnailsOpen } from '../thumbnails/openState';
import { Panel } from './Panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each test uses its own tab id, because the open state of a tab lives in a module-level store.
let host: HTMLDivElement;
let root: Root;
let nextTab = 1000;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

function render(node: ReactElement): void {
  act(() => {
    root.render(node);
  });
}

type MessageKey = Parameters<typeof t>[0];

const RAIL_BUTTONS: {
  name: string;
  key: MessageKey;
  element: (tabId: number | null) => ReactElement;
  isOpen: (tabId: number) => boolean;
}[] = [
  {
    name: 'Thumbnails',
    key: 'thumbnails.title',
    element: (tabId: number | null) => (
      <ThumbnailsRailButton tabId={tabId} disabled={tabId === null} />
    ),
    isOpen: isThumbnailsOpen,
  },
  {
    name: 'Bookmarks',
    key: 'bookmarks.title',
    element: (tabId: number | null) => (
      <BookmarksRailButton tabId={tabId} disabled={tabId === null} />
    ),
    isOpen: isBookmarksOpen,
  },
  {
    name: 'Organizer',
    key: 'organizer.title',
    element: (tabId: number | null) => (
      <OrganizerRailButton tabId={tabId} disabled={tabId === null} />
    ),
    isOpen: isOrganizerOpen,
  },
  {
    name: 'Search',
    key: 'search.title',
    element: (tabId: number | null) => <SearchRailButton tabId={tabId} disabled={tabId === null} />,
    isOpen: isSearchOpen,
  },
];

describe.each(RAIL_BUTTONS)('$name rail button', ({ key, element, isOpen }) => {
  it('opens its panel, is marked while open, and closes from the same button', () => {
    const tabId = nextTab++;
    render(element(tabId));
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.title).toBe(t(key));
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button?.textContent).toBe(t(key));

    act(() => {
      button?.click();
    });
    expect(isOpen(tabId)).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      button?.click();
    });
    expect(isOpen(tabId)).toBe(false);
    expect(button?.getAttribute('aria-pressed')).toBe('false');
  });

  it('is disabled when no document is shown', () => {
    render(element(null));
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });
});

describe('panel frame', () => {
  it('gives the open panel a title and a close button', () => {
    let closed = 0;
    render(
      <Panel
        title={t('bookmarks.title')}
        onClose={() => {
          closed += 1;
        }}
      >
        <p>items</p>
      </Panel>,
    );
    expect(host.querySelector('.panel-toggle')?.textContent).toBe(t('bookmarks.title'));
    const close = host.querySelector<HTMLButtonElement>('.panel-close');
    expect(close?.getAttribute('aria-label')).toBe(
      t('panel.close', { title: t('bookmarks.title') }),
    );
    act(() => {
      close?.click();
    });
    expect(closed).toBe(1);
  });
});
