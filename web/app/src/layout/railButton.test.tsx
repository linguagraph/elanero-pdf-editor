import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { Panel } from './Panel';
import { RailButton } from './RailButton';
import { RAIL_ICONS } from './railIcons';
import { closePanel, PANEL_SIDE, type PanelKey, openPanelOf } from './sidePanels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The side-panel store is module state: every test starts with both sides closed.
  closePanel('left');
  closePanel('right');
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

function press(element: Element | null | undefined): void {
  act(() => {
    (element as HTMLButtonElement).click();
  });
}

function keyDown(element: Element | null | undefined, name: string): void {
  act(() => {
    element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

const PANELS: { panel: PanelKey; label: string }[] = [
  { panel: 'pages', label: t('thumbnails.title') },
  { panel: 'bookmarks', label: t('bookmarks.title') },
  { panel: 'search', label: t('search.title') },
  { panel: 'organizer', label: t('organizer.title') },
];

describe.each(PANELS)('$panel rail button', ({ panel, label }) => {
  it('opens its panel on its side, is marked while open, and closes from the same button', () => {
    render(<RailButton panel={panel} label={label} icon={RAIL_ICONS[panel]} />);
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.getAttribute('aria-controls')).toBe(`app-panel-${PANEL_SIDE[panel]}`);
    expect(button?.title).toBe(label);
    expect(button?.textContent).toBe(label);
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');

    press(button);
    expect(openPanelOf(PANEL_SIDE[panel])).toBe(panel);
    expect(button?.getAttribute('aria-expanded')).toBe('true');

    press(button);
    expect(openPanelOf(PANEL_SIDE[panel])).toBeNull();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });

  it('is disabled when disabled is set', () => {
    render(<RailButton panel={panel} label={label} icon={RAIL_ICONS[panel]} disabled />);
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  });
});

describe('RailButton toggle', () => {
  it('calls onToggle instead of toggling the store when one is given', () => {
    const onToggle = vi.fn();
    render(
      <RailButton
        panel="search"
        label={t('search.title')}
        icon={RAIL_ICONS.search}
        onToggle={onToggle}
      />,
    );
    press(host.querySelector('button'));
    expect(onToggle).toHaveBeenCalledWith('search');
    expect(openPanelOf('left')).toBeNull();
  });
});

describe('rail keyboard', () => {
  it('moves focus up and down between enabled buttons of the same rail, and wraps', () => {
    render(
      <nav className="app-rail">
        <RailButton panel="pages" label={t('thumbnails.title')} icon={RAIL_ICONS.pages} />
        <RailButton panel="bookmarks" label={t('bookmarks.title')} icon={RAIL_ICONS.bookmarks} />
        <RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} disabled />
        <RailButton panel="organizer" label={t('organizer.title')} icon={RAIL_ICONS.organizer} />
      </nav>,
    );
    const pages = host.querySelector<HTMLButtonElement>('[data-panel="pages"]');
    const bookmarks = host.querySelector<HTMLButtonElement>('[data-panel="bookmarks"]');
    const organizer = host.querySelector<HTMLButtonElement>('[data-panel="organizer"]');
    pages?.focus();
    keyDown(pages, 'ArrowDown');
    expect(document.activeElement).toBe(bookmarks);
    keyDown(bookmarks, 'ArrowDown');
    expect(document.activeElement).toBe(organizer);
    keyDown(organizer, 'ArrowDown');
    expect(document.activeElement).toBe(pages);
    keyDown(pages, 'ArrowUp');
    expect(document.activeElement).toBe(organizer);
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
    press(close);
    expect(closed).toBe(1);
  });
});
