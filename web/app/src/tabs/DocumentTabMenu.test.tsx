import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { DocumentTabMenu } from './DocumentTabMenu';
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

function pdf(name: string) {
  return { name, handle: `handle-${name}`, pages: 1 };
}

function threeTabs(): TabState {
  let state = addTab(EMPTY_TABS, pdf('a.pdf'));
  state = addTab(state, pdf('b.pdf'));
  return addTab(state, pdf('c.pdf'));
}

function render(state: TabState, onSelect = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(<DocumentTabMenu state={state} onSelect={onSelect} onClose={onClose} />);
  });
  return { onSelect, onClose };
}

function openMenu(): void {
  act(() => {
    host.querySelector<HTMLElement>('.doc-tabs-menu-button')?.click();
  });
}

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe('document tab drop-down', () => {
  it('shows the active document on the button', () => {
    render(activateTab(threeTabs(), 2));
    expect(host.querySelector('.doc-tabs-menu-button')?.textContent).toContain('b.pdf');
  });

  it('names the button and marks an unsaved active document', () => {
    render(setDirty(activateTab(threeTabs(), 1), 1, true));
    const button = host.querySelector<HTMLElement>('.doc-tabs-menu-button');
    expect(button?.getAttribute('aria-label')).toBe(t('tabs.menu'));
    expect(button?.textContent).toContain(t('tabs.unsaved'));
  });

  it('lists every open document when opened', () => {
    render(activateTab(threeTabs(), 1));
    openMenu();
    expect(items().map((item) => item.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('a.pdf'), expect.stringContaining('c.pdf')]),
    );
    expect(items()).toHaveLength(4);
  });

  it('selects a document chosen from the list', () => {
    const { onSelect } = render(activateTab(threeTabs(), 1));
    openMenu();
    act(() => {
      items()[2]?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('puts the unsaved mark in the accessible name of a dirty document', () => {
    render(setDirty(threeTabs(), 2, true));
    openMenu();
    expect(items()[1]?.textContent).toContain(t('tabs.unsaved'));
    expect(items()[0]?.textContent).not.toContain(t('tabs.unsaved'));
  });

  it('closes the active document from the close item', () => {
    const { onClose } = render(activateTab(threeTabs(), 2));
    openMenu();
    const close = items().find((item) => item.textContent === t('tabs.menuClose'));
    expect(close).toBeDefined();
    act(() => {
      close?.click();
    });
    expect(onClose).toHaveBeenCalledWith(2);
  });
});
