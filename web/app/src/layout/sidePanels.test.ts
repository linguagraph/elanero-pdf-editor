import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePanel,
  openPanel,
  openPanelOf,
  PANEL_SIDE,
  subscribePanels,
  togglePanel,
} from './sidePanels';

// The store is module state, so each test starts with both sides closed.
beforeEach(() => {
  closePanel('left');
  closePanel('right');
});

describe('side panel store', () => {
  it('docks the navigation panels on the left and the organizer on the right', () => {
    expect(PANEL_SIDE).toEqual({
      pages: 'left',
      bookmarks: 'left',
      search: 'left',
      redactions: 'left',
      comments: 'left',
      organizer: 'right',
    });
  });

  it('opens Pages by default, on the left', async () => {
    // A fresh module, before any test has changed the store.
    vi.resetModules();
    const fresh = await import('./sidePanels');
    expect(fresh.openPanelOf('left')).toBe('pages');
    expect(fresh.openPanelOf('right')).toBeNull();
  });

  it('opens a panel on its side, and closes the other panel on that side only', () => {
    openPanel('pages');
    openPanel('organizer');
    expect(openPanelOf('left')).toBe('pages');
    expect(openPanelOf('right')).toBe('organizer');

    openPanel('bookmarks');
    expect(openPanelOf('left')).toBe('bookmarks');
    expect(openPanelOf('right')).toBe('organizer');
  });

  it('toggles a panel: opens it, then closes it from the same key', () => {
    togglePanel('search');
    expect(openPanelOf('left')).toBe('search');
    togglePanel('search');
    expect(openPanelOf('left')).toBeNull();
  });

  it('closes a side', () => {
    openPanel('organizer');
    closePanel('right');
    expect(openPanelOf('right')).toBeNull();
  });

  it('notifies each subscriber once per change, and not when nothing changes', () => {
    const listener = vi.fn();
    const stop = subscribePanels(listener);
    openPanel('pages');
    expect(listener).toHaveBeenCalledTimes(1);
    openPanel('pages');
    expect(listener).toHaveBeenCalledTimes(1);
    closePanel('left');
    expect(listener).toHaveBeenCalledTimes(2);
    closePanel('left');
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    openPanel('bookmarks');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
