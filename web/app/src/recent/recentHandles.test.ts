import { describe, expect, it, vi } from 'vitest';
import { RECENT_LIMIT } from './recentFiles';
import {
  deleteRecentHandleDatabase,
  forgetRecentHandle,
  type HandleStore,
  loadRecentHandle,
  loadRecentHandles,
  pruneRecentHandles,
  RECENT_HANDLE_DB,
  reopenFromHandle,
  saveRecentHandle,
  type StoredFileHandle,
  type StoredRecent,
} from './recentHandles';

// A handle stands in for a FileSystemFileHandle: a name, a getFile and a requestPermission.
function fakeHandle(name: string, permission: 'granted' | 'denied' = 'granted'): StoredFileHandle {
  return {
    name,
    getFile: vi.fn(async () => new File(['%PDF'], name, { type: 'application/pdf' })),
    requestPermission: vi.fn(async () => permission),
  };
}

// An in-memory HandleStore keyed by name, like the IndexedDB one.
class MemoryHandleStore implements HandleStore {
  readonly rows = new Map<string, StoredRecent>();

  async put(entry: StoredRecent): Promise<void> {
    this.rows.set(entry.name, entry);
  }

  async get(name: string): Promise<StoredRecent | undefined> {
    return this.rows.get(name);
  }

  async remove(name: string): Promise<void> {
    this.rows.delete(name);
  }

  async all(): Promise<StoredRecent[]> {
    return [...this.rows.values()];
  }
}

// A store whose every call throws, as a browser with a refusing IndexedDB would.
const throwingStore: HandleStore = {
  put: () => Promise.reject(new Error('quota')),
  get: () => Promise.reject(new Error('blocked')),
  remove: () => Promise.reject(new Error('blocked')),
  all: () => Promise.reject(new Error('blocked')),
};

describe('recent handles: save, load, forget', () => {
  it('saves a handle under its cleaned name and loads it back', async () => {
    const store = new MemoryHandleStore();
    const handle = fakeHandle('report.pdf');
    expect(await saveRecentHandle(store, 'C:\\docs\\report.pdf', handle, 1000)).toBe(true);
    expect(await loadRecentHandle(store, 'report.pdf')).toBe(handle);
    expect(store.rows.has('report.pdf')).toBe(true);
  });

  it('keeps no bytes: the stored record is the name, the time and the handle', async () => {
    const store = new MemoryHandleStore();
    await saveRecentHandle(store, 'a.pdf', fakeHandle('a.pdf'), 1000);
    expect(Object.keys(store.rows.get('a.pdf') ?? {}).sort()).toEqual([
      'handle',
      'name',
      'savedAt',
    ]);
  });

  it('forgets a handle', async () => {
    const store = new MemoryHandleStore();
    await saveRecentHandle(store, 'a.pdf', fakeHandle('a.pdf'));
    await forgetRecentHandle(store, 'a.pdf');
    expect(await loadRecentHandle(store, 'a.pdf')).toBeUndefined();
  });

  it('loads every saved handle by name for the start page', async () => {
    const store = new MemoryHandleStore();
    await saveRecentHandle(store, 'a.pdf', fakeHandle('a.pdf'), 1);
    await saveRecentHandle(store, 'b.pdf', fakeHandle('b.pdf'), 2);
    const map = await loadRecentHandles(store);
    expect([...map.keys()].sort()).toEqual(['a.pdf', 'b.pdf']);
  });

  it('prunes to the recent-list limit, dropping the oldest saved handles', async () => {
    const store = new MemoryHandleStore();
    for (let i = 0; i < RECENT_LIMIT + 2; i += 1) {
      await saveRecentHandle(store, `f${i}.pdf`, fakeHandle(`f${i}.pdf`), i + 1);
    }
    expect(store.rows.size).toBe(RECENT_LIMIT);
    expect(store.rows.has('f0.pdf')).toBe(false);
    expect(store.rows.has(`f${RECENT_LIMIT + 1}.pdf`)).toBe(true);
  });

  it('prune keeps the newest entries when called directly', async () => {
    const store = new MemoryHandleStore();
    await saveRecentHandle(store, 'old.pdf', fakeHandle('old.pdf'), 1);
    await saveRecentHandle(store, 'new.pdf', fakeHandle('new.pdf'), 2);
    await pruneRecentHandles(store, 1);
    expect([...store.rows.keys()]).toEqual(['new.pdf']);
  });

  it('a store that throws gives no handle and never throws to the caller', async () => {
    expect(await loadRecentHandle(throwingStore, 'a.pdf')).toBeUndefined();
    expect((await loadRecentHandles(throwingStore)).size).toBe(0);
    expect(await saveRecentHandle(throwingStore, 'a.pdf', fakeHandle('a.pdf'))).toBe(false);
    await expect(forgetRecentHandle(throwingStore, 'a.pdf')).resolves.toBeUndefined();
  });

  it('no store (no IndexedDB) does nothing', async () => {
    expect(await saveRecentHandle(undefined, 'a.pdf', fakeHandle('a.pdf'))).toBe(false);
    expect(await loadRecentHandle(undefined, 'a.pdf')).toBeUndefined();
  });

  it('a name that is empty after cleaning is not saved', async () => {
    const store = new MemoryHandleStore();
    expect(await saveRecentHandle(store, '   ', fakeHandle('x.pdf'))).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});

describe('recent handles: reopen from a handle', () => {
  it('asks for permission and returns the file when it is granted', async () => {
    const handle = fakeHandle('a.pdf', 'granted');
    const file = await reopenFromHandle(handle);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'read' });
    expect(file?.name).toBe('a.pdf');
  });

  it('gives undefined (fall back to the picker) when permission is refused', async () => {
    const handle = fakeHandle('a.pdf', 'denied');
    expect(await reopenFromHandle(handle)).toBeUndefined();
    expect(handle.getFile).not.toHaveBeenCalled();
  });

  it('gives undefined when getFile fails, for example a moved file', async () => {
    const handle: StoredFileHandle = {
      ...fakeHandle('a.pdf'),
      getFile: async () => {
        throw new DOMException('gone', 'NotFoundError');
      },
    };
    expect(await reopenFromHandle(handle)).toBeUndefined();
  });

  it('calls requestPermission before any await, so the click gesture still applies', () => {
    const handle = fakeHandle('a.pdf');
    void reopenFromHandle(handle);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('gives undefined when there is no handle', async () => {
    expect(await reopenFromHandle(undefined)).toBeUndefined();
  });
});

describe('recent handles: the database', () => {
  it('deletes the elanero-recent database', async () => {
    const deleteDatabase = vi.fn(() => {
      const request: { onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    });
    const factory = { deleteDatabase } as unknown as IDBFactory;
    expect(await deleteRecentHandleDatabase(factory)).toBe(true);
    expect(deleteDatabase).toHaveBeenCalledWith(RECENT_HANDLE_DB);
    expect(RECENT_HANDLE_DB).toBe('elanero-recent');
  });

  it('reports false when the delete fails, and never throws', async () => {
    const factory = {
      deleteDatabase: () => {
        const request: { onsuccess?: () => void; onerror?: () => void; error?: unknown } = {};
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    } as unknown as IDBFactory;
    expect(await deleteRecentHandleDatabase(factory)).toBe(false);
  });

  it('reports false when the delete is blocked by an open connection', async () => {
    // A blocked delete stays pending until the connection closes, so it must not be waited on.
    const factory = {
      deleteDatabase: () => {
        const request: { onblocked?: () => void } = {};
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    } as unknown as IDBFactory;
    expect(await deleteRecentHandleDatabase(factory)).toBe(false);
  });

  it('reports true when the browser has no IndexedDB', async () => {
    expect(await deleteRecentHandleDatabase(undefined)).toBe(true);
  });
});
