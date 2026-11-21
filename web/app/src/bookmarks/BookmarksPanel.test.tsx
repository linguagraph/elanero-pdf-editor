import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { OutlineEntry } from '../rpc/generated';
import { BookmarksPanel } from './BookmarksPanel';
import { RailButton } from '../layout/RailButton';
import { RAIL_ICONS } from '../layout/railIcons';
import { closePanel, openPanel, useOpenPanel } from '../layout/sidePanels';
import { expandedOf, fingerprintOf, forgetBookmarksTab, setExpandedOf } from './expansion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // The side-panel store is module state: every test starts with both sides closed.
  closePanel('left');
  closePanel('right');
});

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
  revision = 0,
}: {
  tabId: number;
  rpc: PageRpc;
  onSelect: (index: number) => void;
  revision?: number;
}) {
  const open = useOpenPanel('left') === 'bookmarks';
  let panel: ReactNode = null;
  if (open) {
    panel = (
      <BookmarksPanel
        rpc={rpc}
        handle="h"
        tabId={tabId}
        currentPage={0}
        revision={revision}
        onHistoryStep={() => undefined}
        onSelect={onSelect}
        onClose={() => closePanel('left')}
      />
    );
  }
  return (
    <div>
      <RailButton panel="bookmarks" label={t('bookmarks.title')} icon={RAIL_ICONS.bookmarks} />
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
  const found = host.querySelector<HTMLButtonElement>('button[data-panel="bookmarks"]');
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
    openPanel('bookmarks');
    await mount(1, rpc);
    expect(call).toHaveBeenCalledWith('session.outline', { handle: 'h' });
    expect(host.querySelector('[role="tree"]')).not.toBeNull();
    expect(titles()).toEqual(['Part One', 'Part Two']);
    expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
    expect(item('Part One').getAttribute('aria-level')).toBe('1');
  });

  it('expands and collapses the nested levels', async () => {
    const { rpc } = fakeRpc(outline);
    openPanel('bookmarks');
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
    openPanel('bookmarks');
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
    openPanel('bookmarks');
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
    openPanel('bookmarks');
    await mount(10, rpc);
    expect(items().map((element) => element.tabIndex)).toEqual([0, -1]);
    await key(item('Part One'), 'End');
    expect(items().map((element) => element.tabIndex)).toEqual([-1, 0]);
  });

  it('starts expanded where the file flags the entry as open', async () => {
    const { rpc } = fakeRpc([entry('Open part', 1, 0, true), entry('Its child', 2, 1)]);
    openPanel('bookmarks');
    await mount(4, rpc);
    expect(titles()).toEqual(['Open part', 'Its child']);
  });

  it('shows the empty message when the document has no outline', async () => {
    const { rpc } = fakeRpc([]);
    openPanel('bookmarks');
    await mount(5, rpc);
    expect(host.textContent).toContain(t('bookmarks.empty'));
    expect(host.querySelector('[role="tree"]')).toBeNull();
  });

  it('shows an alert when the outline cannot be read', async () => {
    const rpc = {
      call: vi.fn(() => Promise.reject(new Error('gone'))),
    } as unknown as PageRpc;
    openPanel('bookmarks');
    await mount(6, rpc);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('bookmarks.loadFailed'));
  });

  it('keeps the open panel, and the expansion per tab', async () => {
    const { rpc } = fakeRpc(outline);
    await mount(7, rpc);
    await click(railButton());
    expect(railButton().getAttribute('aria-expanded')).toBe('true');
    await flush();
    await click(toggleOf('Part One'));
    expect(titles()).toContain('Chapter 1.1');

    // The open panel is global: another tab shows it open too.
    await mount(8, rpc);
    expect(railButton().getAttribute('aria-expanded')).toBe('true');

    // Back on the first tab, the panel is still open and still expanded.
    await mount(7, rpc);
    expect(railButton().getAttribute('aria-expanded')).toBe('true');
    expect(titles()).toContain('Chapter 1.1');
  });

  it('forgets a closed tab, and an outline with other content starts from the file flags', () => {
    const key = fingerprintOf(outline);
    setExpandedOf(20, key, new Set([0]));
    expect(expandedOf(20, key)).toEqual(new Set([0]));
    expect(expandedOf(20, fingerprintOf(outline.slice(1)))).toBeUndefined();
    forgetBookmarksTab(20);
    expect(expandedOf(20, key)).toBeUndefined();
  });
});

// A fake engine that also has outline_write, so the editing keys and the toolbar are on.
function editableRpc(entries: OutlineEntry[]) {
  const call = vi.fn((method: string) => {
    if (method === 'session.outline') return Promise.resolve({ entries });
    if (method === 'session.capabilities') {
      return Promise.resolve({ engine: { outline_write: true }, platform: {} });
    }
    if (method === 'actions.run') {
      return Promise.resolve({
        label: 'Move Bookmark',
        executed: true,
        value: null,
        changed: null,
        state: { history: 1 },
      });
    }
    return Promise.reject(new Error(`unexpected call ${method}`));
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

async function press(element: HTMLElement, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    element.dispatchEvent(event);
  });
  await flush();
  return event;
}

describe('bookmarks editing (W5.2 S2)', () => {
  it('moves the entry with Alt+Shift+Arrow and sends the engine its parent and position', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(9, rpc);
    await press(item('Part Two'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.move',
      args: { index: 3, expect_title: 'Part Two', parent: null, position: 0 },
    });
  });

  it('leaves Alt+Arrow alone, so the app Back and Forward keys still work', async () => {
    // The child is an outdent target (Alt+Shift+Left would move it), so a missing Shift check
    // would send an edit here.
    const { rpc, call } = editableRpc([entry('Part', 1, 0, true), entry('Child', 2, 1)]);
    openPanel('bookmarks');
    await mount(14, rpc);
    const event = await press(item('Child'), { key: 'ArrowLeft', altKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toEqual([]);
  });

  it('a read-only outline still takes the edit keys, so the Edit tool does not see them', async () => {
    // fakeRpc has no session.capabilities answer, so the outline reads as not editable.
    const { rpc, call } = fakeRpc(outline);
    openPanel('bookmarks');
    await mount(11, rpc);
    const del = await press(item('Part One'), { key: 'Delete' });
    expect(del.defaultPrevented).toBe(true);
    const rename = await press(item('Part One'), { key: 'F2' });
    expect(rename.defaultPrevented).toBe(true);
    expect(host.querySelector('input.bookmarks-rename')).toBeNull();
    expect(call).not.toHaveBeenCalledWith('actions.run', expect.anything());
  });

  it('renames in place: F2 opens the field, Enter sends the trimmed title', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(9, rpc);
    await press(item('Part Two'), { key: 'F2' });
    const field = host.querySelector<HTMLInputElement>('input.bookmarks-rename');
    expect(field).not.toBeNull();
    if (field === null) return;
    field.value = '  Part Two B ';
    await press(field, { key: 'Enter' });
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.rename',
      args: { index: 3, expect_title: 'Part Two', title: 'Part Two B' },
    });
  });

  it('Escape closes the rename field without an edit', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(9, rpc);
    await press(item('Part Two'), { key: 'F2' });
    const field = host.querySelector<HTMLInputElement>('input.bookmarks-rename');
    if (field === null) throw new Error('no rename field');
    await press(field, { key: 'Escape' });
    expect(host.querySelector('input.bookmarks-rename')).toBeNull();
    expect(call).not.toHaveBeenCalledWith('actions.run', expect.anything());
  });

  it('closes an open rename when a reload replaces the outline under it', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(13, rpc);
    await press(item('Part Two'), { key: 'F2' });
    expect(host.querySelector('input.bookmarks-rename')).not.toBeNull();
    act(() => {
      root.render(<Harness tabId={13} rpc={rpc} onSelect={vi.fn()} revision={1} />);
    });
    await flush();
    expect(host.querySelector('input.bookmarks-rename')).toBeNull();
    expect(call).not.toHaveBeenCalledWith('actions.run', expect.anything());
  });

  it('ignores an edit key while the reload after an edit is still running', async () => {
    const reload: { resolve?: (value: { entries: OutlineEntry[] }) => void } = {};
    let outlineReads = 0;
    const call = vi.fn((method: string) => {
      if (method === 'session.outline') {
        outlineReads += 1;
        if (outlineReads === 1) return Promise.resolve({ entries: outline });
        // The reload after the edit waits until the test resolves it.
        return new Promise((resolve) => {
          reload.resolve = resolve;
        });
      }
      if (method === 'session.capabilities') {
        return Promise.resolve({ engine: { outline_write: true }, platform: {} });
      }
      if (method === 'actions.run') {
        return Promise.resolve({
          label: 'Move Bookmark',
          executed: true,
          value: null,
          changed: null,
          state: { history: 1 },
        });
      }
      return Promise.reject(new Error(`unexpected call ${method}`));
    });
    const rpc = { call } as unknown as PageRpc;
    const runs = () => call.mock.calls.filter(([method]) => method === 'actions.run');
    openPanel('bookmarks');
    await mount(12, rpc);
    await press(item('Part Two'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(runs()).toHaveLength(1);
    // The outline is still the one the edit replaced, so a second move is ignored.
    await press(item('Part Two'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(runs()).toHaveLength(1);
    await act(async () => {
      reload.resolve?.({ entries: outline });
    });
    await flush();
    await press(item('Part Two'), { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(runs()).toHaveLength(2);
  });
});
