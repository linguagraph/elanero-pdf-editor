import { describe, expect, it, vi } from 'vitest';
import type { EngineClient, EngineConnection } from '../engine/engineConnection';
import type { OpenResult } from '../rpc/generated';
import type { AutosaveStore } from '../storage/autosaveStore';
import type { DocumentTab } from '../tabs/tabState';
import { restartSession } from './engineSession';

const TABS: DocumentTab[] = [
  { id: 1, name: 'a.pdf', dirty: true, handle: 'h1', pages: 2 },
  { id: 2, name: 'b.pdf', dirty: false, handle: 'h2', pages: 3 },
];

// A store that holds a copy for tab 1 only: the other document has none.
function storeWithCopyOf1(bytes: ArrayBuffer): AutosaveStore {
  return {
    available: vi.fn(() => Promise.resolve(true)),
    write: vi.fn(),
    read: vi.fn((_tab: string, docId: number) =>
      Promise.resolve(
        docId === 1 ? { bytes, meta: { name: 'a.pdf', time: 'now', pages: 2 } } : undefined,
      ),
    ),
    remove: vi.fn(),
    removeTab: vi.fn(),
  } as unknown as AutosaveStore;
}

describe('restartSession (W3.9 restart)', () => {
  it('lists each open tab as a document, keyed by its tab id', () => {
    const session = restartSession({
      engine: {} as EngineConnection,
      tabs: TABS,
      tabId: 'browser-tab',
      store: storeWithCopyOf1(new ArrayBuffer(1)),
      isProtected: () => false,
      reopened: vi.fn(),
    });

    expect(session.documents).toEqual([
      { id: '1', name: 'a.pdf' },
      { id: '2', name: 'b.pdf' },
    ]);
  });

  it('reads the autosave copy of a document from this browser tab, and none when absent', async () => {
    const bytes = new ArrayBuffer(8);
    const store = storeWithCopyOf1(bytes);
    const session = restartSession({
      engine: {} as EngineConnection,
      tabs: TABS,
      tabId: 'browser-tab',
      store,
      isProtected: () => false,
      reopened: vi.fn(),
    });

    expect(await session.bytesOf('1')).toBe(bytes);
    expect(await session.bytesOf('2')).toBeUndefined();
    expect(store.read).toHaveBeenCalledWith('browser-tab', 1);
  });

  it('opens the copy in the new engine and hands the answer back for the tab', async () => {
    const opened: OpenResult = { handle: 'h-new', pages: 2, warning: null } as OpenResult;
    const call = vi.fn(() => Promise.resolve(opened));
    const client = { call } as unknown as EngineClient;
    const reopened = vi.fn();
    const session = restartSession({
      engine: {} as EngineConnection,
      tabs: TABS,
      tabId: 'browser-tab',
      store: storeWithCopyOf1(new ArrayBuffer(1)),
      isProtected: () => false,
      reopened,
    });
    const bytes = new ArrayBuffer(4);

    await session.reopen({ id: '1', name: 'a.pdf' }, bytes, client);

    expect(call).toHaveBeenCalledWith('session.open', {
      name: 'a.pdf',
      data: bytes,
      password: null,
    });
    expect(reopened).toHaveBeenCalledWith(1, client, opened);
  });

  it('asks the autosaver whether a document is protected, by tab id', () => {
    const isProtected = vi.fn((id: number) => id === 2);
    const session = restartSession({
      engine: {} as EngineConnection,
      tabs: TABS,
      tabId: 'browser-tab',
      store: storeWithCopyOf1(new ArrayBuffer(1)),
      isProtected,
      reopened: vi.fn(),
    });

    expect(session.isProtected('2')).toBe(true);
    expect(session.isProtected('1')).toBe(false);
  });
});
