import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { layoutForWidth } from './breakpoints';
import { LayoutProvider } from './LayoutContext';
import { NarrowNotice } from './NarrowNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DISMISSED_KEY = 'elanero.layout.narrowNoticeDismissed';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

// The notice reads the tier from the layout context, as it does inside the frame.
function renderAt(width: number): void {
  act(() => {
    root.render(
      <LayoutProvider regions={layoutForWidth(width)}>
        <NarrowNotice />
      </LayoutProvider>,
    );
  });
}

function notice(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[role="status"]');
}

function dismissButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('.narrow-notice-dismiss');
}

describe('NarrowNotice', () => {
  it('shows the notice at the phone tier', () => {
    renderAt(390);
    expect(notice()?.textContent).toContain(t('layout.narrowNotice'));
    expect(dismissButton()?.textContent).toBe(t('layout.narrowNotice.dismiss'));
  });

  it.each([768, 1024, 1366])('is not shown at %i px', (width) => {
    renderAt(width);
    expect(notice()).toBeNull();
  });

  it('hides when dismissed, and stays hidden after a re-render', () => {
    renderAt(390);
    act(() => {
      dismissButton()?.click();
    });
    expect(notice()).toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBe('1');

    renderAt(390);
    expect(notice()).toBeNull();
  });

  it('stays hidden for a new mount in the same session', () => {
    sessionStorage.setItem(DISMISSED_KEY, '1');
    renderAt(390);
    expect(notice()).toBeNull();
  });

  it('is still dismissible when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderAt(390);
    expect(notice()).not.toBeNull();
    act(() => {
      dismissButton()?.click();
    });
    expect(notice()).toBeNull();
  });
});
