import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BookmarksRailButton } from '../bookmarks/BookmarksRailButton';
import { isBookmarksOpen } from '../bookmarks/openState';
import { t } from '../i18n/t';
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

function render(node: React.ReactNode): void {
  act(() => {
    root.render(node);
  });
}

describe('side rail and panel', () => {
  it('opens the panel from its rail button, marks the button, and closes it from the same button', () => {
    const tabId = nextTab++;
    render(<BookmarksRailButton tabId={tabId} disabled={false} />);
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.title).toBe(t('bookmarks.title'));

    act(() => {
      button?.click();
    });
    expect(isBookmarksOpen(tabId)).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    act(() => {
      button?.click();
    });
    expect(isBookmarksOpen(tabId)).toBe(false);
    expect(button?.getAttribute('aria-pressed')).toBe('false');
  });

  it('has no open state to change when no document is shown', () => {
    render(<BookmarksRailButton tabId={null} disabled />);
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });

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
