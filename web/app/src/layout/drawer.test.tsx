import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppFrame } from './AppFrame';
import { Panel } from './Panel';
import { RailButton } from './RailButton';
import { closePanel, useOpenPanel } from './sidePanels';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A small shell: a Pages rail button, its panel with one focusable control inside, and a page
// with a focusable scroller (DocumentView's .doc-view-scroll), wired as App wires them.
function Shell() {
  const left = useOpenPanel('left');
  return (
    <AppFrame
      header={<span>top</span>}
      onDismissPanel={closePanel}
      leftRail={<RailButton panel="pages" label="Pages" icon={<svg aria-hidden="true" />} />}
      leftPanel={
        left === 'pages' ? (
          <Panel title="Pages" onClose={() => closePanel('left')}>
            <button type="button">Page one</button>
          </Panel>
        ) : undefined
      }
    >
      <div className="doc-view-scroll" tabIndex={0}>
        <button type="button">Page area</button>
      </div>
    </AppFrame>
  );
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function render(width: number): void {
  setWidth(width);
  act(() => {
    root.render(<Shell />);
  });
}

function press(element: Element | null | undefined): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function pressKey(key: string, target: Element | null = document.activeElement): void {
  act(() => {
    (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

// A pointerdown as the browser sends it on a tap; jsdom has no PointerEvent constructor here.
function tap(target: Element | null | undefined): void {
  act(() => {
    target?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
}

function railButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.app-rail-left button');
  if (!button) throw new Error('no rail button');
  return button;
}

function leftPanel(): HTMLElement | null {
  return host.querySelector<HTMLElement>('.app-panel-left');
}

function pageButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('.doc-view-scroll button');
  if (!button) throw new Error('no page button');
  return button;
}

describe('floating panels (drawer at the tablet tier)', () => {
  it('moves focus into the drawer when it opens', () => {
    render(900);
    press(railButton());
    expect(leftPanel()).not.toBeNull();
    expect(leftPanel()?.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and returns focus to the rail button that opened it', () => {
    render(900);
    press(railButton());
    pressKey('Escape');
    expect(leftPanel()).toBeNull();
    expect(document.activeElement).toBe(railButton());
  });

  it('closes on Escape pressed while focus is on the page, and leaves focus alone', () => {
    render(900);
    press(railButton());
    act(() => {
      pageButton().focus();
    });
    pressKey('Escape', pageButton());
    expect(leftPanel()).toBeNull();
    expect(document.activeElement).toBe(pageButton());
  });

  it('closes on a tap on the page area', () => {
    render(900);
    press(railButton());
    tap(pageButton());
    expect(leftPanel()).toBeNull();
  });

  it('stays open for a tap inside the panel or on its own rail', () => {
    render(900);
    press(railButton());
    const inside = leftPanel()?.querySelector('button');
    tap(inside);
    expect(leftPanel()).not.toBeNull();
    tap(railButton());
    expect(leftPanel()).not.toBeNull();
  });
});

describe('docked panel (wide tier)', () => {
  it('keeps the panel open on Escape and moves focus to the page', () => {
    render(1366);
    press(railButton());
    const inside = leftPanel()?.querySelector<HTMLButtonElement>('button');
    act(() => {
      inside?.focus();
    });
    pressKey('Escape', inside ?? null);
    expect(leftPanel()).not.toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.doc-view-scroll'));
  });

  it('does not close on a tap outside', () => {
    render(1366);
    press(railButton());
    tap(pageButton());
    expect(leftPanel()).not.toBeNull();
  });
});
