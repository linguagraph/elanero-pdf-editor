import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { OutlineEntry } from '../rpc/generated';
import { BookmarksPanel } from './BookmarksPanel';
import { BookmarksRailButton } from './BookmarksRailButton';
import { setBookmarksOpen, useBookmarksOpen } from './openState';

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

function titled(title: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button.bookmarks-title')].find(
    (button) => button.textContent === title,
  );
  if (found === undefined) throw new Error(`no bookmark ${title}`);
  return found;
}

function toggle(title: string, expanded: boolean): HTMLButtonElement {
  const label = t(expanded ? 'bookmarks.collapse' : 'bookmarks.expand', { title });
  const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`no toggle ${label}`);
  return found;
}

function railButton(): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>('button.bookmarks-rail-button');
  if (found === null) throw new Error('no rail button');
  return found;
}

function titles(): string[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button.bookmarks-title')].map(
    (button) => button.textContent ?? '',
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await flush();
}

describe('bookmarks side panel', () => {
  it('renders the outline as a tree that starts collapsed', async () => {
    const { rpc, call } = fakeRpc(outline);
    setBookmarksOpen(1, true);
    act(() => {
      root.render(<Harness tabId={1} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    expect(call).toHaveBeenCalledWith('session.outline', { handle: 'h' });
    expect(titles()).toEqual(['Part One', 'Part Two']);
    expect(toggle('Part One', false).getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelectorAll<HTMLElement>('li.bookmarks-row')[0]?.dataset.depth).toBe('1');
  });

  it('expands and collapses the nested levels', async () => {
    const { rpc } = fakeRpc(outline);
    setBookmarksOpen(2, true);
    act(() => {
      root.render(<Harness tabId={2} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    await click(toggle('Part One', false));
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Part Two']);
    await click(toggle('Chapter 1.1', false));
    expect(titles()).toEqual(['Part One', 'Chapter 1.1', 'Section 1.1.1', 'Part Two']);
    expect(host.querySelectorAll<HTMLElement>('li.bookmarks-row')[2]?.dataset.depth).toBe('3');
    await click(toggle('Part One', true));
    expect(titles()).toEqual(['Part One', 'Part Two']);
  });

  it('a click on an entry asks for its page, and an entry without a page is disabled', async () => {
    const { rpc } = fakeRpc(outline);
    const onSelect = vi.fn();
    setBookmarksOpen(3, true);
    act(() => {
      root.render(<Harness tabId={3} rpc={rpc} onSelect={onSelect} />);
    });
    await flush();
    await click(toggle('Part One', false));
    await click(toggle('Chapter 1.1', false));
    await click(titled('Section 1.1.1'));
    expect(onSelect).toHaveBeenLastCalledWith(2);
    expect(titled('Part Two').disabled).toBe(true);
  });

  it('starts expanded where the file flags the entry as open', async () => {
    const { rpc } = fakeRpc([entry('Open part', 1, 0, true), entry('Its child', 2, 1)]);
    setBookmarksOpen(4, true);
    act(() => {
      root.render(<Harness tabId={4} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    expect(titles()).toEqual(['Open part', 'Its child']);
  });

  it('shows the empty message when the document has no outline', async () => {
    const { rpc } = fakeRpc([]);
    setBookmarksOpen(5, true);
    act(() => {
      root.render(<Harness tabId={5} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    expect(host.textContent).toContain(t('bookmarks.empty'));
    expect(host.querySelector('ul.bookmarks-list')).toBeNull();
  });

  it('shows an alert when the outline cannot be read', async () => {
    const rpc = {
      call: vi.fn(() => Promise.reject(new Error('gone'))),
    } as unknown as PageRpc;
    setBookmarksOpen(6, true);
    act(() => {
      root.render(<Harness tabId={6} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('bookmarks.loadFailed'));
  });

  it('keeps the open state and the expansion per tab', async () => {
    const { rpc } = fakeRpc(outline);
    act(() => {
      root.render(<Harness tabId={7} rpc={rpc} onSelect={vi.fn()} />);
    });
    await click(railButton());
    expect(railButton().getAttribute('aria-pressed')).toBe('true');
    await flush();
    await click(toggle('Part One', false));
    expect(titles()).toContain('Chapter 1.1');

    // Another tab starts with the panel closed.
    act(() => {
      root.render(<Harness tabId={8} rpc={rpc} onSelect={vi.fn()} />);
    });
    expect(railButton().getAttribute('aria-pressed')).toBe('false');

    // Back on the first tab, the panel is still open and still expanded.
    act(() => {
      root.render(<Harness tabId={7} rpc={rpc} onSelect={vi.fn()} />);
    });
    await flush();
    expect(railButton().getAttribute('aria-pressed')).toBe('true');
    expect(titles()).toContain('Chapter 1.1');
  });
});
