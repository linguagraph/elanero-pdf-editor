import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineLoadStore } from '../feedback/engineLoad';
import { createNotRespondingStore } from '../feedback/notResponding';
import { createToastStore } from '../feedback/toasts';
import type { EngineClient, EngineConnection } from '../engine/engineConnection';
import { EngineLoadError } from '../engine/errors';
import type { OpenResult } from '../rpc/generated';
import { type AutosaveCopy, type AutosaveStore } from '../storage/autosaveStore';
import { createAutosaver } from '../storage/autosaver';
import {
  addTab,
  closeTab,
  type DocumentTab,
  EMPTY_TABS,
  replaceHandle,
  setDirty,
  type TabState,
} from '../tabs/tabState';
import { restartSession } from './engineSession';

const TABS: DocumentTab[] = [
  {
    id: 1,
    name: 'a.pdf',
    dirty: true,
    handle: 'h1',
    pages: 2,
    encrypted: false,
    signed: false,
    canUndo: false,
    canRedo: false,
    busy: false,
    restored: false,
  },
  {
    id: 2,
    name: 'b.pdf',
    dirty: false,
    handle: 'h2',
    pages: 3,
    encrypted: false,
    signed: false,
    canUndo: false,
    canRedo: false,
    busy: false,
    restored: false,
  },
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
      isOpen: () => true,
      reopened: vi.fn(),
      lost: vi.fn(),
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
      isOpen: () => true,
      reopened: vi.fn(),
      lost: vi.fn(),
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
      isOpen: () => true,
      reopened,
      lost: vi.fn(),
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
      isOpen: () => true,
      reopened: vi.fn(),
      lost: vi.fn(),
    });

    expect(session.isProtected('2')).toBe(true);
    expect(session.isProtected('1')).toBe(false);
  });
});

describe('the tabs after a restart (W3.9 S3)', () => {
  it('a tab closed while its copy opens is not re-attached, and its new handle is closed', async () => {
    const openIds = new Set([1]);
    const call = vi.fn((method: string) =>
      method === 'session.open'
        ? Promise.resolve({ handle: 'h-new', pages: 2, warning: null } as OpenResult)
        : Promise.resolve({}),
    );
    const client = { call } as unknown as EngineClient;
    const reopened = vi.fn();
    const session = restartSession({
      engine: {} as EngineConnection,
      tabs: TABS,
      tabId: 'browser-tab',
      store: storeWithCopyOf1(new ArrayBuffer(1)),
      isProtected: () => false,
      isOpen: (id) => openIds.has(id),
      reopened,
      lost: vi.fn(),
    });

    // The user closes the tab while session.open is pending.
    const pending = session.reopen({ id: '1', name: 'a.pdf' }, new ArrayBuffer(4), client);
    openIds.delete(1);
    await pending;

    expect(reopened).not.toHaveBeenCalled();
    expect(call).toHaveBeenLastCalledWith('session.close', { handle: 'h-new' });
  });

  it('a reopened tab takes its new handle, and a tab that cannot come back is closed', async () => {
    // Two documents: a.pdf has an autosave copy, b.pdf has none.
    let state: TabState = addTab(addTab(EMPTY_TABS, { name: 'a.pdf', handle: 'h1', pages: 2 }), {
      name: 'b.pdf',
      handle: 'h2',
      pages: 3,
    });
    const opened = { handle: 'h-new', pages: 2, warning: null } as OpenResult;
    const client = { call: vi.fn(() => Promise.resolve(opened)) } as unknown as EngineClient;
    const engine = {
      store: createEngineLoadStore(),
      restart: () => true,
      whenReady: () => Promise.resolve(client),
    } as unknown as EngineConnection;
    const session = restartSession({
      engine,
      tabs: state.tabs,
      tabId: 'browser-tab',
      store: storeWithCopyOf1(new ArrayBuffer(4)),
      isProtected: () => false,
      isOpen: () => true,
      reopened: (id, _client, result) => {
        state = replaceHandle(state, id, result.handle, result.pages);
      },
      lost: (id) => {
        state = closeTab(state, id);
      },
    });
    const notResponding = createNotRespondingStore({
      restart: () => ({ ok: true, reopen: session.documents, lost: { items: [], text: '' } }),
      toasts: createToastStore(),
    });
    notResponding.setSession(session);

    await notResponding.restart();

    expect(state.tabs).toEqual([
      expect.objectContaining({
        id: 1,
        name: 'a.pdf',
        dirty: true,
        handle: 'h-new',
        pages: 2,
        encrypted: false,
      }),
    ]);
    expect(state.activeId).toBe(1);
  });
});

// A store that really holds the copies, so a test can see which ones survive a restart.
function mapStore() {
  const copies = new Map<number, AutosaveCopy>();
  const removes: number[] = [];
  const store: AutosaveStore = {
    available: async () => true,
    write: async (_tab, docId, bytes, meta) => {
      copies.set(docId, { bytes, meta });
      return 'written';
    },
    read: async (_tab, docId) => copies.get(docId),
    remove: async (_tab, docId) => {
      removes.push(docId);
      copies.delete(docId);
    },
    removeTab: async () => undefined,
  };
  return { store, copies, removes };
}

// Two dirty documents, each with a copy the autosaver wrote through the old engine. The wiring
// follows useDocuments: a lost document is released by the autosaver before its tab closes, and
// the autosaver is then synced with the tabs that remain.
async function documentsWithCopies() {
  const fake = mapStore();
  const oldEngine = {
    call: vi.fn(async () => ({ data: new ArrayBuffer(4), size: 4, skipped: null })),
  };
  const autosaver = createAutosaver({
    tabId: 'browser-tab',
    store: fake.store,
    client: () => oldEngine as unknown as Pick<EngineClient, 'call'>,
    warn: () => undefined,
  });
  let state: TabState = setDirty(
    setDirty(
      addTab(addTab(EMPTY_TABS, { name: 'a.pdf', handle: 'h1', pages: 2 }), {
        name: 'b.pdf',
        handle: 'h2',
        pages: 3,
      }),
      1,
      true,
    ),
    2,
    true,
  );
  autosaver.sync(state.tabs);
  await vi.advanceTimersByTimeAsync(10);
  expect([...fake.copies.keys()].sort()).toEqual([1, 2]);
  return {
    fake,
    autosaver,
    tabs: () => state,
    restartWith(engine: EngineConnection) {
      const session = restartSession({
        engine,
        tabs: state.tabs,
        tabId: 'browser-tab',
        store: fake.store,
        isProtected: (id) => autosaver.isProtected(id),
        isOpen: () => true,
        reopened: (id, _client, opened) => {
          state = replaceHandle(state, id, opened.handle, opened.pages);
        },
        lost: (id) => {
          autosaver.release(id);
          state = closeTab(state, id);
        },
      });
      return session;
    },
    settle: async () => {
      autosaver.sync(state.tabs);
      await vi.advanceTimersByTimeAsync(10);
    },
  };
}

describe('a restart keeps the copies it does not reopen (W3.9 S3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a new engine that fails to load leaves every copy in the store', async () => {
    const docs = await documentsWithCopies();
    const loadStore = createEngineLoadStore();
    const engine = {
      store: loadStore,
      restart: () => true,
      whenReady: () => new Promise<EngineClient>(() => undefined),
    } as unknown as EngineConnection;
    const notResponding = createNotRespondingStore({
      restart: () => ({ ok: true, reopen: [], lost: { items: [], text: '' } }),
      toasts: createToastStore(),
    });
    notResponding.setSession(docs.restartWith(engine));

    const pending = notResponding.restart();
    loadStore.fail(new EngineLoadError('pyodide', 'the engine did not load'));
    await pending;
    await docs.settle();

    expect(docs.tabs().tabs).toEqual([]);
    expect(docs.fake.removes).toEqual([]);
    expect([...docs.fake.copies.keys()].sort()).toEqual([1, 2]);
  });

  it('a document that cannot be reopened keeps its copy, and the others reopen', async () => {
    const docs = await documentsWithCopies();
    const opened = { handle: 'h-new', pages: 3, warning: null } as OpenResult;
    const client = {
      call: vi
        .fn()
        .mockRejectedValueOnce(new Error('session.open failed'))
        .mockResolvedValueOnce(opened),
    } as unknown as EngineClient;
    const engine = {
      store: createEngineLoadStore(),
      restart: () => true,
      whenReady: () => Promise.resolve(client),
    } as unknown as EngineConnection;
    const notResponding = createNotRespondingStore({
      restart: () => ({ ok: true, reopen: [], lost: { items: [], text: '' } }),
      toasts: createToastStore(),
    });
    notResponding.setSession(docs.restartWith(engine));

    await notResponding.restart();
    await docs.settle();

    // a.pdf (id 1) failed to reopen: its tab is closed and its copy is the one the user can recover.
    expect(docs.tabs().tabs.map((tab) => tab.id)).toEqual([2]);
    expect(docs.tabs().tabs[0]?.handle).toBe('h-new');
    expect(docs.fake.removes).not.toContain(1);
    expect(docs.fake.copies.has(1)).toBe(true);
  });
});
