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

function render(state: TabState, onSelect = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(<DocumentTabs state={state} onSelect={onSelect} onClose={onClose} />);
  });
  return { onSelect, onClose };
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

  it('closes a tab from its named close button', () => {
    const { onClose } = render(threeTabs());
    const close = host.querySelector<HTMLElement>(
      `[aria-label="${t('tabs.close', { name: 'b.pdf' })}"]`,
    );
    expect(close).not.toBeNull();
    act(() => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledWith(2);
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
