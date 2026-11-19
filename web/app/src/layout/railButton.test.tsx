import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { Panel } from './Panel';
import { RailButton } from './RailButton';
import { RAIL_ICONS } from './railIcons';
import {
  closePanel,
  openPanel,
  openPanelOf,
  PANEL_SIDE,
  type PanelKey,
  useOpenPanel,
} from './sidePanels';

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
    expect(button?.hasAttribute('aria-controls')).toBe(false);
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

// A stand-in for the panel slot: it is mounted only while its panel is open, as in the app.
const PANEL_ID = 'app-panel-test';

function PanelRig({ panel, label }: { panel: PanelKey; label: string }) {
  const open = useOpenPanel(PANEL_SIDE[panel]) === panel;
  return (
    <>
      <RailButton panel={panel} label={label} icon={RAIL_ICONS[panel]} controlsId={PANEL_ID} />
      {open ? <aside id={PANEL_ID}>{panel}</aside> : null}
    </>
  );
}

describe.each(PANELS)('$panel aria-controls', ({ panel, label }) => {
  it('names the rendered panel only while the button is expanded', () => {
    render(<PanelRig panel={panel} label={label} />);
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.hasAttribute('aria-controls')).toBe(false);

    press(button);
    const controls = button?.getAttribute('aria-controls') ?? '';
    expect(controls).toBe(PANEL_ID);
    expect(document.getElementById(controls)).not.toBeNull();

    press(button);
    expect(button?.hasAttribute('aria-controls')).toBe(false);
  });

  it('names nothing when no controlsId is given, even while expanded', () => {
    render(<RailButton panel={panel} label={label} icon={RAIL_ICONS[panel]} />);
    press(host.querySelector('button'));
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('button')?.hasAttribute('aria-controls')).toBe(false);
  });
});

describe('RailButton count', () => {
  const name = () => host.querySelector('.visually-hidden')?.textContent;
  const badge = () => host.querySelector('.rail-badge');

  it('shows no badge and the plain label at zero', () => {
    render(<RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} />);
    expect(badge()).toBeNull();
    expect(name()).toBe(t('search.title'));
    expect(host.querySelector('button')?.title).toBe(t('search.title'));
  });

  it('adds the count to the name and shows it as a badge', () => {
    render(
      <RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} count={1} />,
    );
    expect(name()).toBe('Search, 1 item');
    expect(badge()?.textContent).toBe('1');
    expect(badge()?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reads 99+ in the badge above 99, and keeps the exact count in the name', () => {
    render(
      <RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} count={120} />,
    );
    expect(badge()?.textContent).toBe('99+');
    expect(name()).toBe('Search, 120 items');
  });
});

describe('RailButton while disabled', () => {
  it('is not expanded, even when its side still remembers the panel', () => {
    openPanel('search');
    render(
      <RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} disabled />,
    );
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    closePanel('left');
  });
});

describe('rail keyboard', () => {
  it('moves focus up and down between enabled buttons of the same rail, and wraps', () => {
    render(
      <div className="app-rail" role="toolbar" aria-orientation="vertical">
        <RailButton panel="pages" label={t('thumbnails.title')} icon={RAIL_ICONS.pages} />
        <RailButton panel="bookmarks" label={t('bookmarks.title')} icon={RAIL_ICONS.bookmarks} />
        <RailButton panel="search" label={t('search.title')} icon={RAIL_ICONS.search} disabled />
        <RailButton panel="organizer" label={t('organizer.title')} icon={RAIL_ICONS.organizer} />
      </div>,
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
