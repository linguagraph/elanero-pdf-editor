import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { OutlineEntry } from '../rpc/generated';
import { BookmarksPanel } from './BookmarksPanel';
import { BookmarksRailButton } from './BookmarksRailButton';
import {
  expandedOf,
  forgetBookmarksTab,
  isBookmarksOpen,
  setBookmarksOpen,
  setExpandedOf,
  useBookmarksOpen,
} from './openState';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(title: string, level: number, page: number | null, is_open = false): OutlineEntry {
  return { title, level, page, is_open };
}

// A fake engine: session.outline answers at once with the given entries.
function fakeRpc(entries: OutlineEntry[]) {
  const call = vi.fn((method: string) => {
    if (method === 'session.outline') return Promise.resolve({ entries });
    return Promise.reject(new Error(`unexpected call ${method}`));
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

const outline: OutlineEntry[] = [
  entry('Part One', 1, 0),
  entry('Chapter 1.1', 2, 1),
  entry('Section 1.1.1', 3, 2),
  entry('Part Two', 1, null),
];

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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
  vi.restoreAllMocks();
});

// The side panel as the app composes it: a rail button and, when the tab's panel is open, the panel.
function Harness({
  tabId,
  rpc,
  onSelect,
}: {
  tabId: number;
  rpc: PageRpc;
  onSelect: (index: number) => void;
}) {
  const open = useBookmarksOpen(tabId);
  let panel: ReactNode = null;
  if (open) {
    panel = (
      <BookmarksPanel
        rpc={rpc}
        handle="h"
        tabId={tabId}
        onSelect={onSelect}
        onClose={() => setBookmarksOpen(tabId, false)}
      />
    );
  }
  return (
    <div>
      <BookmarksRailButton tabId={tabId} disabled={false} />
      {panel}
    </div>
  );
}

function items(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

function item(title: string): HTMLElement {
  const found = items().find((element) => element.textContent === title);
  if (found === undefined) throw new Error(`no bookmark ${title}`);
  return found;
}

function titles(): string[] {
  return items().map((element) => element.textContent ?? '');
}

function toggleOf(title: string): HTMLElement {
  const found = item(title).querySelector<HTMLElement>('.bookmarks-toggle');
  if (found === null) throw new Error(`no toggle on ${title}`);
  return found;
}

function railButton(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('button.bookmarks-rail-button');
  if (found === null) throw new Error('no rail button');
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

async function key(element: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
  await flush();
}

async function mount(tabId: number, rpc: PageRpc, onSelect = vi.fn()): Promise<void> {
  act(() => {
    root.render(<Harness tabId={tabId} rpc={rpc} onSelect={onSelect} />);
  });
  await flush();
}

describe('bookmarks side panel', () => {
  it('renders the outline as a tree that starts collapsed', async () => {
    const { rpc, call } = fakeRpc(outline);
    setBookmarksOpen(1, true);
    await mount(1, rpc);
    expect(call).toHaveBeenCalledWith('session.outline', { handle: 'h' });
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(titles()).toEqual(['Part One', 'Part Two']);
    expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
    expect(item('Part One').getAttribute('aria-level')).toBe('1');
  });

  it('expands and collapses the nested levels', async () => {
    const { rpc } = fakeRpc(outline);
    setBookmarksOpen(2, true);
    await mount(2, rpc);
    await click(toggleOf('Part One'));
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Part Two']);
    await click(toggleOf('Chapter 1.1'));
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Section 1.1.1', 'Part Two']);
    expect(item('Section 1.1.1').getAttribute('aria-level')).toBe('3');
    await click(toggleOf('Part One'));
    expect(titles()).toEqual(['Part One', 'Part Two']);
  });

  it('a click on an entry asks for its page, and an entry without a page is disabled', async () => {
    const { rpc } = fakeRpc(outline);
    const onSelect = vi.fn();
    setBookmarksOpen(3, true);
    await mount(3, rpc, onSelect);
    await click(toggleOf('Part One'));
    await click(toggleOf('Chapter 1.1'));
    await click(item('Section 1.1.1'));
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(item('Part Two').getAttribute('aria-disabled')).toBe('true');
    await click(item('Part Two'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('moves the focus and opens or closes entries with the keys', async () => {
    const { rpc } = fakeRpc(outline);
    const onSelect = vi.fn();
    setBookmarksOpen(9, true);
    await mount(9, rpc, onSelect);
    item('Part One').focus();
    await key(item('Part One'), 'ArrowRight');
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Part Two']);
    expect(document.activeElement).toBe(item('Part One'));
    await key(item('Part One'), 'ArrowDown');
    expect(document.activeElement).toBe(item('Chapter 1.1'));
    await key(item('Chapter 1.1'), 'ArrowRight');
    await key(item('Section 1.1.1'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('Chapter 1.1'));
    await key(item('Chapter 1.1'), 'Enter');
    expect(onSelect).toHaveBeenLastCalledWith(1);
    await key(item('Chapter 1.1'), 'ArrowLeft');
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Part Two']);
    await key(item('Chapter 1.1'), 'ArrowLeft');
    expect(document.activeElement).toBe(item('Part One'));
    await key(item('Part One'), 'ArrowLeft');
    expect(titles()).toEqual(['Part One', 'Part Two']);
  });

  it('gives only the focused row a tab stop', async () => {
    const { rpc } = fakeRpc(outline);
    setBookmarksOpen(10, true);
    await mount(10, rpc);
    expect(items().map((element) => element.tabIndex)).toEqual([0, -1]);
    await key(item('Part One'), 'End');
    expect(items().map((element) => element.tabIndex)).toEqual([-1, 0]);
  });

  it('starts expanded where the file flags the entry as open', async () => {
    const { rpc } = fakeRpc([entry('Open part', 1, 0, true), entry('Its child', 2, 1)]);
    setBookmarksOpen(4, true);
    await mount(4, rpc);
    expect(titles()).toEqual(['Open part', 'Its child']);
  });

  it('shows the empty message when the document has no outline', async () => {
    const { rpc } = fakeRpc([]);
    setBookmarksOpen(5, true);
    await mount(5, rpc);
    expect(host.textContent).toContain(t('bookmarks.empty'));
    expect(host.querySelector('[role="tree"]')).toBeNull();
  });

  it('shows an alert when the outline cannot be read', async () => {
    const rpc = {
      call: vi.fn(() => Promise.reject(new Error('gone'))),
    } as unknown as PageRpc;
    setBookmarksOpen(6, true);
    await mount(6, rpc);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('bookmarks.loadFailed'));
  });

  it('keeps the open state and the expansion per tab', async () => {
    const { rpc } = fakeRpc(outline);
    await mount(7, rpc);
    await click(railButton());
    expect(railButton().getAttribute('aria-pressed')).toBe('true');
    await flush();
    await click(toggleOf('Part One'));
    expect(titles()).toContain('Chapter 1.1');

    // Another tab starts with the panel closed.
    await mount(8, rpc);
    expect(railButton().getAttribute('aria-pressed')).toBe('false');

    // Back on the first tab, the panel is still open and still expanded.
    await mount(7, rpc);
    expect(railButton().getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toContain('Chapter 1.1');
  });

  it('forgets a closed tab, and an outline of another length starts from the file flags', () => {
    setBookmarksOpen(20, true);
    setExpandedOf(20, 4, new Set([0]));
    expect(expandedOf(20, 4)).toEqual(new Set([0]));
    expect(expandedOf(20, 5)).toBeUndefined();
    forgetBookmarksTab(20);
    expect(isBookmarksOpen(20)).toBe(false);
    expect(expandedOf(20, 4)).toBeUndefined();
  });
});
