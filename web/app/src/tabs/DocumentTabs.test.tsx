import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { DocumentTabs } from './DocumentTabs';
import { activateTab, addTab, EMPTY_TABS, setDirty, type TabState } from './tabState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a collection mounts.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let host: HTMLDivElement;
let root: Root;

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

function render(state: TabState, onSelect = vi.fn(), onClose = vi.fn(), onOpen = vi.fn()) {
  act(() => {
    root.render(
      <DocumentTabs state={state} onSelect={onSelect} onClose={onClose} onOpen={onOpen} />,
    );
  });
  return { onSelect, onClose, onOpen };
}

function openButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('.doc-strip-open');
}

function pdf(name: string) {
  return { name, handle: `handle-${name}`, pages: 1 };
}

function threeTabs(): TabState {
  let state = addTab(EMPTY_TABS, pdf('a.pdf'));
  state = addTab(state, pdf('b.pdf'));
  return addTab(state, pdf('c.pdf'));
}

function tabs(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function key(target: Element, name: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
}

describe('document tabs', () => {
  it('renders nothing when no document is open', () => {
    render(EMPTY_TABS);
    expect(host.querySelector('[role="tablist"]')).toBeNull();
  });

  it('shows one tab per document, with the active one selected', () => {
    render(threeTabs());
    expect(tabs().map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('a.pdf'),
      expect.stringContaining('b.pdf'),
      expect.stringContaining('c.pdf'),
    ]);
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true',
    ]);
  });

  it('names the tab list and marks an unsaved document', () => {
    const state = setDirty(threeTabs(), 1, true);
    render(state);
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe(
      t('tabs.label'),
    );
    expect(tabs()[0]?.textContent).toContain(t('tabs.unsaved'));
    expect(tabs()[1]?.textContent).not.toContain(t('tabs.unsaved'));
  });

  it('closes a tab from its pointer close mark, without selecting it', () => {
    const { onClose, onSelect } = render(threeTabs());
    const close = tabs()[1]?.querySelector<HTMLElement>('.doc-tab-close');
    expect(close).not.toBeNull();
    act(() => {
      close?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      close?.click();
    });
    expect(onClose).toHaveBeenCalledWith(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the close mark out of the accessibility tree and the tab order', () => {
    render(threeTabs());
    for (const close of host.querySelectorAll<HTMLElement>('.doc-tab-close')) {
      expect(close.getAttribute('aria-hidden')).toBe('true');
      expect(close.matches('button, a, input, [tabindex]')).toBe(false);
    }
    // The one button in the strip is the + button, after the tab list.
    expect([...host.querySelectorAll('button')]).toEqual([openButton()]);
  });

  it('closes the focused tab with Delete', () => {
    const { onClose } = render(activateTab(threeTabs(), 1));
    tabs()[1]?.focus();
    key(tabs()[1] as HTMLElement, 'Delete');
    expect(onClose).toHaveBeenCalledWith(2);
  });

  it('moves focus to the next tab when Delete closes the middle one', () => {
    const { onClose } = render(activateTab(threeTabs(), 1));
    tabs()[1]?.focus();
    key(tabs()[1] as HTMLElement, 'Delete');
    expect(onClose).toHaveBeenCalledWith(2);
    expect(document.activeElement).toBe(tabs()[2]);
  });

  it('moves focus to the previous tab when Delete closes the last one', () => {
    const { onClose } = render(activateTab(threeTabs(), 3));
    tabs()[2]?.focus();
    key(tabs()[2] as HTMLElement, 'Delete');
    expect(onClose).toHaveBeenCalledWith(3);
    expect(document.activeElement).toBe(tabs()[1]);
  });

  it('does not close a tab when Delete is pressed on something that is not a tab', () => {
    const { onClose } = render(threeTabs());
    key(host.querySelector('[role="tablist"]') as HTMLElement, 'Delete');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('moves between tabs with the arrow keys', () => {
    const { onSelect } = render(activateTab(threeTabs(), 1));
    const first = tabs()[0];
    first?.focus();
    key(first as HTMLElement, 'ArrowRight');
    expect(onSelect).toHaveBeenLastCalledWith(2);
    key(tabs()[1] as HTMLElement, 'ArrowLeft');
    expect(onSelect).toHaveBeenLastCalledWith(1);
  });

  it('jumps to the first and last tab with Home and End', () => {
    const { onSelect } = render(activateTab(threeTabs(), 2));
    key(tabs()[1] as HTMLElement, 'Home');
    expect(onSelect).toHaveBeenLastCalledWith(1);
    key(tabs()[0] as HTMLElement, 'End');
    expect(onSelect).toHaveBeenLastCalledWith(3);
  });

  it('marks only the active tab as aria-selected after the selection changes', () => {
    render(activateTab(threeTabs(), 1));
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    render(activateTab(threeTabs(), 2));
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('describes the Delete key on each tab', () => {
    render(threeTabs());
    for (const tab of tabs()) {
      const hint = document.getElementById(tab.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent).toBe(t('tabs.closeHint'));
    }
  });

  it('makes the selected tab control a panel that exists, and no other tab', () => {
    render(activateTab(threeTabs(), 2));
    const controls = tabs().map((tab) => tab.getAttribute('aria-controls'));
    expect(controls[0]).toBeNull();
    expect(controls[1]).not.toBeNull();
    expect(controls[2]).toBeNull();
    expect(document.getElementById(controls[1] ?? '')?.getAttribute('role')).toBe('tabpanel');
  });

  it('selects a tab when it is clicked', () => {
    const { onSelect } = render(threeTabs());
    act(() => {
      tabs()[0]?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});

describe('document tab names', () => {
  it('truncates a long name and shows the full name as a tooltip', () => {
    const long = 'a-very-long-document-name-that-does-not-fit.pdf';
    render(addTab(EMPTY_TABS, pdf(long)));
    const name = host.querySelector<HTMLElement>('.doc-tab-name');
    expect(name?.getAttribute('title')).toBe(long);
    expect(name?.textContent).toBe(long);
  });
});

describe('document tabs by width', () => {
  const original = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
  });

  function setWidth(width: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }

  it('keeps the strip at 1024 px and wider', () => {
    setWidth(1024);
    render(threeTabs());
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelector('.doc-tabs-menu-button')).toBeNull();
  });

  it('becomes a drop-down below 1024 px, with no tab strip', () => {
    setWidth(1023);
    render(activateTab(threeTabs(), 3));
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    const button = host.querySelector<HTMLElement>('.doc-tabs-menu-button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('c.pdf');
  });
});

describe('the + button', () => {
  it('shows only while a document is open', () => {
    render(EMPTY_TABS);
    expect(openButton()).toBeNull();
    act(() => {
      root.render(
        <DocumentTabs
          state={addTab(EMPTY_TABS, pdf('a.pdf'))}
          onSelect={vi.fn()}
          onClose={vi.fn()}
          onOpen={vi.fn()}
        />,
      );
    });
    expect(openButton()).not.toBeNull();
  });

  it('is named as the open command and runs onOpen when clicked', () => {
    const { onOpen } = render(addTab(EMPTY_TABS, pdf('a.pdf')));
    const button = openButton();
    expect(button?.getAttribute('aria-label')).toBe(t('command.open.label'));
    expect(button?.getAttribute('title')).toBe(t('command.open.label'));
    act(() => {
      button?.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
