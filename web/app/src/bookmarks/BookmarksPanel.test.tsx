import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { OutlineEntry } from '../rpc/generated';
import { ICONS, type IconName } from '../theme/icons.generated';
import type { ViewPlace } from '../view/layout';
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
  return { title, level, page, is_open, top: null };
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
// What the view supplies beyond the outline (W5.2 S3): the place, the labels and the selection.
interface HarnessExtra {
  readonly place?: () => ViewPlace | null;
  readonly labels?: readonly string[];
  readonly selectedText?: () => string | null;
}

function Harness({
  tabId,
  rpc,
  onSelect,
  revision = 0,
  place = () => null,
  labels = [],
  selectedText = () => null,
}: {
  tabId: number;
  rpc: PageRpc;
  onSelect: (index: number, top: number | null) => void;
  revision?: number;
} & HarnessExtra) {
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
        location={place}
        labels={labels}
        selectedText={selectedText}
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

async function mount(
  tabId: number,
  rpc: PageRpc,
  onSelect = vi.fn(),
  extra: HarnessExtra = {},
): Promise<void> {
  act(() => {
    root.render(<Harness tabId={tabId} rpc={rpc} onSelect={onSelect} {...extra} />);
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
    expect(onSelect).toHaveBeenLastCalledWith(2, null);
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
    expect(onSelect).toHaveBeenLastCalledWith(1, null);
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

// An outline that changes after the first read: the reload after an add shows the new entry.
function addingRpc(before: OutlineEntry[], after: OutlineEntry[]) {
  let reads = 0;
  const call = vi.fn((method: string) => {
    if (method === 'session.outline') {
      reads += 1;
      return Promise.resolve({ entries: reads === 1 ? before : after });
    }
    if (method === 'session.capabilities') {
      return Promise.resolve({ engine: { outline_write: true }, platform: {} });
    }
    if (method === 'actions.run') {
      return Promise.resolve({
        label: 'Add Bookmark',
        executed: true,
        value: 3,
        changed: null,
        state: { history: 2 },
      });
    }
    return Promise.reject(new Error(`unexpected call ${method}`));
  });
  return { rpc: { call } as unknown as PageRpc, call };
}

// The toolbar's buttons are icons, so a button is found by its accessible name (aria-label) only.
function buttonNamed(name: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

// The empty state's text button has no aria-label, so it is found by its visible text.
function buttonWithText(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === text,
  );
  if (found === undefined) throw new Error(`no button with text ${text}`);
  return found;
}

// The shape of each icon element, as "tag attr=value ..." (sorted), so two icons compare equal only
// when their drawn parts match.
function shapesOf(svg: Element | null): string[] {
  return [...(svg?.children ?? [])].map(
    (el) =>
      `${el.tagName.toLowerCase()} ${[...el.attributes]
        .map((attr) => `${attr.name}=${attr.value}`)
        .sort()
        .join(' ')}`,
  );
}

function shapesOfIcon(name: IconName): string[] {
  return ICONS[name].map(
    ([tag, attrs]) =>
      `${tag} ${Object.entries(attrs)
        .map(([key, value]) => `${key}=${String(value)}`)
        .sort()
        .join(' ')}`,
  );
}

const ADD_KEYS: KeyboardEventInit = { key: 'N', altKey: true, shiftKey: true, code: 'KeyN' };

describe('bookmarks adding (W5.2 S3)', () => {
  it('Alt+Shift+N adds after the row at the view place and opens its title selected', async () => {
    const { rpc, call } = addingRpc(outline, [
      ...outline.slice(0, 3),
      { ...entry('Page 1', 1, 0), top: 120.5 },
      ...outline.slice(3),
    ]);
    openPanel('bookmarks');
    await mount(20, rpc, vi.fn(), { place: () => ({ page: 0, top: 120.5 }) });
    const event = await press(item('Part One'), ADD_KEYS);
    expect(event.defaultPrevented).toBe(true);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.add',
      args: {
        title: 'Page 1',
        page: 0,
        y: 120.5,
        after: 0,
        as_child: false,
        expect_after: 'Part One',
      },
    });
    await flush();
    const field = host.querySelector<HTMLInputElement>('input.bookmarks-rename');
    expect(field?.value).toBe('Page 1');
    expect(field?.selectionStart).toBe(0);
    expect(field?.selectionEnd).toBe('Page 1'.length);
  });

  it('Escape keeps the suggested title with no second edit', async () => {
    const { rpc, call } = addingRpc(outline, [
      ...outline.slice(0, 3),
      { ...entry('Page 1', 1, 0), top: null },
      ...outline.slice(3),
    ]);
    openPanel('bookmarks');
    await mount(21, rpc);
    await press(item('Part One'), ADD_KEYS);
    await flush();
    const field = host.querySelector<HTMLInputElement>('input.bookmarks-rename');
    if (field === null) throw new Error('no rename field');
    await press(field, { key: 'Escape' });
    expect(host.querySelector('input.bookmarks-rename')).toBeNull();
    const runs = call.mock.calls.filter(([method]) => method === 'actions.run');
    expect(runs).toHaveLength(1);
  });

  it('names the new bookmark after the selected text, else the page label', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(22, rpc, vi.fn(), {
      selectedText: () => '  Selected   words \nsecond line',
      labels: ['i'],
    });
    await press(item('Part One'), ADD_KEYS);
    expect(call).toHaveBeenCalledWith(
      'actions.run',
      expect.objectContaining({ args: expect.objectContaining({ title: 'Selected words' }) }),
    );
  });

  it('Add Child on the toolbar adds the first child of the row', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(23, rpc);
    await click(item('Part One'));
    await click(buttonNamed('Add Child'));
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.add',
      args: {
        title: 'Page 1',
        page: 0,
        y: null,
        after: 0,
        as_child: true,
        expect_after: 'Part One',
      },
    });
  });

  it('Add Child is off where the outline is deepest', async () => {
    const { rpc } = editableRpc([entry('Deep', 32, 0)]);
    openPanel('bookmarks');
    await mount(24, rpc);
    expect(buttonNamed('Add Child').disabled).toBe(true);
    expect(buttonNamed('Add').disabled).toBe(false);
  });

  it('an empty outline offers Add Bookmark only when it can be edited', async () => {
    const { rpc, call } = editableRpc([]);
    openPanel('bookmarks');
    await mount(25, rpc);
    await click(buttonWithText('Add Bookmark'));
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.add',
      args: { title: 'Page 1', page: 0, y: null, after: null, as_child: false, expect_after: null },
    });
    const { rpc: readOnly } = fakeRpc([]);
    closePanel('left');
    openPanel('bookmarks');
    await mount(26, readOnly);
    // The empty state's button has no aria-label, so its visible text is its name here.
    const names = [...host.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent,
    );
    expect(names).not.toContain('Add Bookmark');
  });

  it('each toolbar button is icon-only and draws the icon its label names', async () => {
    const { rpc } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(26, rpc);
    await click(item('Part One'));
    // Each label with the icon that must draw it: swapping two icons changes the shapes and fails.
    const expected: Array<[string, IconName]> = [
      [t('bookmarks.add'), 'bookmark-plus'],
      [t('bookmarks.addChild'), 'plus'],
      [t('bookmarks.rename'), 'pencil'],
      [t('bookmarks.delete'), 'trash-2'],
      [t('bookmarks.moveUp'), 'chevron-up'],
      [t('bookmarks.moveDown'), 'chevron-down'],
      [t('bookmarks.indent'), 'arrow-right'],
      [t('bookmarks.outdent'), 'arrow-left'],
      [t('bookmarks.setDestination'), 'map-pin'],
    ];
    const toolbar = host.querySelector('[role="toolbar"]');
    expect(toolbar?.querySelectorAll('button')).toHaveLength(expected.length);
    for (const [label, icon] of expected) {
      const button = buttonNamed(label);
      const svg = button.querySelector('svg.icon');
      expect(svg, label).not.toBeNull();
      expect(button.textContent, label).toBe('');
      expect(shapesOf(svg), label).toEqual(shapesOfIcon(icon));
      expect(button.getAttribute('title'), label).toContain(label);
    }
  });

  it('Set to Current Page sends the view place, offset included', async () => {
    const { rpc, call } = editableRpc(outline);
    openPanel('bookmarks');
    await mount(27, rpc, vi.fn(), { place: () => ({ page: 2, top: 40 }) });
    await click(item('Part One'));
    await click(buttonNamed('Set to Current Page'));
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.set_destination',
      args: { index: 0, expect_title: 'Part One', page: 2, y: 40 },
    });
  });

  it('a click on an entry with an offset goes to that offset', async () => {
    const { rpc } = fakeRpc([{ ...entry('Part One', 1, 0), top: 40 }]);
    const onSelect = vi.fn();
    openPanel('bookmarks');
    await mount(28, rpc, onSelect);
    await click(item('Part One'));
    expect(onSelect).toHaveBeenLastCalledWith(0, 40);
  });
});

// Drag and drop (W5.2): jsdom has no layout, so the list spans 400 px, each row is 44 px tall and the
// rows are stacked from the list's top (all open, so row position and flat index agree). The pointer
// is driven with mouse or touch events that carry a pointer id and type, sent to the tree as the
// browser does while the pointer is captured.
describe('bookmarks drag and drop (W5.2)', () => {
  const open: OutlineEntry[] = [
    entry('Part One', 1, 0, true),
    entry('Chapter 1.1', 2, 1, true),
    entry('Section 1.1.1', 3, 2),
    entry('Part Two', 1, null),
  ];

  function tree(): HTMLElement {
    const el = document.querySelector<HTMLElement>('[role="tree"]');
    if (el === null) throw new Error('no tree');
    return el;
  }

  function pointerAt(target: Element, type: string, x: number, y: number, pointerType = 'mouse') {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperties(event, {
      pointerId: { value: 1 },
      pointerType: { value: pointerType },
    });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  // The pointer's position on row `index`, its middle band.
  const rowMiddle = (index: number) => index * 44 + 22;

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const rect = (top: number, bottom: number) =>
        ({ left: 0, top, bottom, right: 300, width: 300, height: bottom - top }) as DOMRect;
      if (this === tree()) return rect(0, 400);
      const index = this instanceof HTMLElement ? Number(this.dataset.index) : Number.NaN;
      return Number.isInteger(index) ? rect(index * 44, index * 44 + 44) : rect(0, 0);
    });
    // The auto-scroll frames are not run; the edge tests do not need them.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops a bookmark on the line below an open entry, one level deeper, as its first child', async () => {
    const { rpc, call } = editableRpc(open);
    const onSelect = vi.fn();
    openPanel('bookmarks');
    await mount(40, rpc, onSelect);
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3));
    pointerAt(tree(), 'pointermove', 56, 140);
    // y = 82 is the bottom band of Chapter 1.1 (rows are 44 px), x = 56 picks level 3.
    pointerAt(tree(), 'pointermove', 56, 82);
    pointerAt(tree(), 'pointerup', 56, 82);
    await flush();
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.move',
      args: { index: 3, expect_title: 'Part Two', parent: 1, position: 0 },
    });
    // The release ends the press without a navigation.
    act(() => {
      item('Part Two').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drops a bookmark inside a row as its last child', async () => {
    const { rpc, call } = editableRpc(open);
    openPanel('bookmarks');
    await mount(41, rpc);
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3));
    pointerAt(tree(), 'pointermove', 56, 40);
    pointerAt(tree(), 'pointermove', 56, rowMiddle(0));
    pointerAt(tree(), 'pointerup', 56, rowMiddle(0));
    await flush();
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h',
      name: 'outline.move',
      args: { index: 3, expect_title: 'Part Two', parent: 0, position: 1 },
    });
  });

  it('refuses a drop into the own subtree: the tree says so and nothing is sent', async () => {
    const { rpc, call } = editableRpc(open);
    openPanel('bookmarks');
    await mount(42, rpc);
    pointerAt(item('Part One'), 'pointerdown', 20, rowMiddle(0));
    pointerAt(tree(), 'pointermove', 56, 30);
    // The middle of Section 1.1.1, which sits inside Part One.
    pointerAt(tree(), 'pointermove', 56, rowMiddle(2));
    expect(tree().dataset.drag).toBe('refused');
    expect(document.body.textContent).toContain(t('bookmarks.drop.own'));
    pointerAt(tree(), 'pointerup', 56, rowMiddle(2));
    await flush();
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toEqual([]);
  });

  it('Escape cancels a running drag, announces it, and sends nothing', async () => {
    const { rpc, call } = editableRpc(open);
    openPanel('bookmarks');
    await mount(43, rpc);
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3));
    pointerAt(tree(), 'pointermove', 56, 140);
    pointerAt(tree(), 'pointermove', 56, 82);
    act(() => {
      tree().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(document.body.textContent).toContain(t('bookmarks.drop.cancelled'));
    // The panel stays open: only a drag consumes the Escape.
    expect(tree().isConnected).toBe(true);
    pointerAt(tree(), 'pointerup', 56, 82);
    await flush();
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toEqual([]);
  });

  it('a touch press and move does nothing: touch keeps the toolbar', async () => {
    const { rpc, call } = editableRpc(open);
    openPanel('bookmarks');
    await mount(44, rpc);
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3), 'touch');
    pointerAt(tree(), 'pointermove', 56, 140, 'touch');
    pointerAt(tree(), 'pointermove', 56, 82, 'touch');
    pointerAt(tree(), 'pointerup', 56, 82, 'touch');
    await flush();
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toEqual([]);
  });

  // Spring-loading (W5.2 slice B): Part One is closed, so its inside is the drop target that opens it.
  // Part Two starts the drag; the timers are faked only after mount, so the mount's own timeout runs.
  const closed: OutlineEntry[] = [
    entry('Part One', 1, 0),
    entry('Chapter 1.1', 2, 1),
    entry('Section 1.1.1', 3, 2),
    entry('Part Two', 1, null),
  ];

  async function startDragOfPartTwo(tabId: number, rpc: PageRpc): Promise<void> {
    openPanel('bookmarks');
    await mount(tabId, rpc);
    pointerAt(item('Part Two'), 'pointerdown', 20, 150);
    pointerAt(tree(), 'pointermove', 56, 150);
  }

  it('spring-loading opens a closed entry the pointer rests on for 800 ms, and not before', async () => {
    const { rpc } = editableRpc(closed);
    await startDragOfPartTwo(45, rpc);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // y = 22 is the middle of Part One, which is closed and has children.
      pointerAt(tree(), 'pointermove', 56, 22);
      act(() => {
        vi.advanceTimersByTime(799);
      });
      expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(item('Part One').getAttribute('aria-expanded')).toBe('true');
      expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Part Two']);
    } finally {
      vi.useRealTimers();
    }
    act(() => {
      tree().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
  });

  it('spring-loading is cancelled when the pointer leaves the row before 800 ms', async () => {
    const { rpc, call } = editableRpc(closed);
    await startDragOfPartTwo(46, rpc);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pointerAt(tree(), 'pointermove', 56, 22);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      // y = 60 is the gap above Part Two, outside Part One: the timer must be gone.
      pointerAt(tree(), 'pointermove', 56, 60);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
    // Escape ends the drag without a move (a release here would move Part Two to the top).
    act(() => {
      tree().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(call.mock.calls.filter(([method]) => method === 'actions.run')).toEqual([]);
  });

  it('spring-loading never opens the dragged entry itself, however long the pointer rests on it', async () => {
    const { rpc } = editableRpc(closed);
    openPanel('bookmarks');
    await mount(51, rpc);
    // Part One is closed and has children, and it is the entry being dragged.
    pointerAt(item('Part One'), 'pointerdown', 20, rowMiddle(0));
    // Starts the drag over Part Two, so no timer is armed before the fake clock is on.
    pointerAt(tree(), 'pointermove', 56, rowMiddle(1));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pointerAt(tree(), 'pointermove', 56, rowMiddle(0));
      act(() => {
        vi.advanceTimersByTime(800);
      });
      expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
      expect(titles()).toEqual(['Part One', 'Part Two']);
    } finally {
      vi.useRealTimers();
    }
    act(() => {
      tree().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
  });

  it('releasing the pointer before 800 ms clears the spring-load timer: nothing expands later', async () => {
    const { rpc } = editableRpc(closed);
    await startDragOfPartTwo(52, rpc);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      pointerAt(tree(), 'pointermove', 56, 22);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      pointerAt(tree(), 'pointerup', 56, 22);
      // The release ends the drag, so its timer is gone, not just ignored.
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(item('Part One').getAttribute('aria-expanded')).toBe('false');
    } finally {
      vi.useRealTimers();
    }
  });

  // The indent per level comes from --bookmarks-indent on the list, read once per drag. The fixture
  // is `open`, so the gap below Section 1.1.1 (y = 134, row 3's top band) takes levels 1 to 3, and
  // x = 60 is level 2 at a 40 px indent but level 3 at the 20 px fallback.
  async function gapDepthAt(tabId: number, indent: string | null, x: number): Promise<string> {
    const { rpc } = editableRpc(open);
    openPanel('bookmarks');
    await mount(tabId, rpc);
    const list = tree();
    if (indent !== null) list.style.setProperty('--bookmarks-indent', indent);
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3));
    pointerAt(list, 'pointermove', x, rowMiddle(3));
    pointerAt(list, 'pointermove', x, 134);
    const depth = item('Part Two').dataset.dropDepth ?? '';
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    return depth;
  }

  it('the drop level uses the indent in --bookmarks-indent', async () => {
    expect(await gapDepthAt(47, '40px', 60)).toBe('2');
  });

  it('without --bookmarks-indent the drop level falls back to 20 px', async () => {
    expect(await gapDepthAt(48, null, 60)).toBe('3');
  });

  it('the drop level mirrors in a right-to-left list, at the same indent', async () => {
    const { rpc } = editableRpc(open);
    openPanel('bookmarks');
    await mount(49, rpc);
    const list = tree();
    list.style.setProperty('--bookmarks-indent', '40px');
    // Left to right, 60 px from the left edge is level 2.
    pointerAt(item('Part Two'), 'pointerdown', 20, rowMiddle(3));
    pointerAt(list, 'pointermove', 60, rowMiddle(3));
    pointerAt(list, 'pointermove', 60, 134);
    expect(item('Part Two').dataset.dropDepth).toBe('2');
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    // Right to left, the same 60 px from the right edge (the list is 300 px wide) is level 2 too.
    list.style.direction = 'rtl';
    pointerAt(item('Part Two'), 'pointerdown', 280, rowMiddle(3));
    pointerAt(list, 'pointermove', 240, rowMiddle(3));
    pointerAt(list, 'pointermove', 240, 134);
    expect(item('Part Two').dataset.dropDepth).toBe('2');
    act(() => {
      list.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
  });
});
