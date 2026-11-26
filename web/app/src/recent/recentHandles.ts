// Reopening a recent file without the picker (issue 756). On Chromium a file the user opened, or
// dropped, is kept as a File System Access handle: an opaque browser reference to the file on
// disk. Only the handle is stored, in IndexedDB, keyed by the file's cleaned name and pruned to the
// recent-list limit. No bytes are stored and nothing is uploaded. Every browser without the API
// (or where the store throws) keeps today's picker, so each function here is a no-op or gives
// undefined there and never throws.
import { cleanRecentName, RECENT_LIMIT } from './recentFiles';

export const RECENT_HANDLE_DB = 'elanero-recent';
const STORE = 'handles';

// The part of a FileSystemFileHandle this module uses. The stored object is the real handle; the
// narrow type keeps the module independent of the DOM library's File System Access typings.
export interface StoredFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  requestPermission(options: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
}

export interface StoredRecent {
  // The cleaned file name, the key of the store.
  readonly name: string;
  // Milliseconds since the epoch: when the handle was saved. The newest are kept by pruning.
  readonly savedAt: number;
  readonly handle: StoredFileHandle;
}

// The store the functions below use. The IndexedDB one is made by createRecentHandleStore; tests
// pass an in-memory one.
export interface HandleStore {
  put(entry: StoredRecent): Promise<void>;
  get(name: string): Promise<StoredRecent | undefined>;
  remove(name: string): Promise<void>;
  all(): Promise<StoredRecent[]>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Opens the database for one call and closes it after, so a later delete is never blocked by an
// open connection.
async function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(RECENT_HANDLE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'name' });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await request(act(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

function createIndexedDbStore(factory: IDBFactory): HandleStore {
  return {
    put: async (entry) => {
      await withStore(factory, 'readwrite', (store) => store.put(entry));
    },
    get: (name) => withStore<StoredRecent | undefined>(factory, 'readonly', (s) => s.get(name)),
    remove: async (name) => {
      await withStore(factory, 'readwrite', (store) => store.delete(name));
    },
    all: () => withStore<StoredRecent[]>(factory, 'readonly', (store) => store.getAll()),
  };
}

// The IndexedDB store, or undefined when the browser has no IndexedDB (or it throws on access).
export function createRecentHandleStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): HandleStore | undefined {
  try {
    return factory ? createIndexedDbStore(factory) : undefined;
  } catch {
    return undefined;
  }
}

// Keeps the newest `limit` handles and removes the rest.
export async function pruneRecentHandles(store: HandleStore, limit = RECENT_LIMIT): Promise<void> {
  const newestFirst = (await store.all()).sort((a, b) => b.savedAt - a.savedAt);
  for (const entry of newestFirst.slice(limit)) {
    await store.remove(entry.name);
  }
}

// Saves a handle under its cleaned name, then prunes. Returns false when nothing was saved (no
// store, an empty name, or a store that throws); it never throws.
export async function saveRecentHandle(
  store: HandleStore | undefined,
  name: string,
  handle: StoredFileHandle,
  now: number = Date.now(),
): Promise<boolean> {
  const key = cleanRecentName(name);
  if (store === undefined || key === null) return false;
  try {
    await store.put({ name: key, savedAt: now, handle });
    await pruneRecentHandles(store);
    return true;
  } catch {
    return false;
  }
}

export async function loadRecentHandle(
  store: HandleStore | undefined,
  name: string,
): Promise<StoredFileHandle | undefined> {
  const key = cleanRecentName(name);
  if (store === undefined || key === null) return undefined;
  try {
    return (await store.get(key))?.handle;
  } catch {
    return undefined;
  }
}

// Every saved handle by name, for the start page to hold in memory: a click needs the handle
// without an await before the permission request.
export async function loadRecentHandles(
  store: HandleStore | undefined,
): Promise<Map<string, StoredFileHandle>> {
  const handles = new Map<string, StoredFileHandle>();
  if (store === undefined) return handles;
  try {
    for (const entry of await store.all()) handles.set(entry.name, entry.handle);
  } catch {
    // An unreadable store gives no handles; every recent row then uses the picker.
  }
  return handles;
}

export async function forgetRecentHandle(
  store: HandleStore | undefined,
  name: string,
): Promise<void> {
  const key = cleanRecentName(name);
  if (store === undefined || key === null) return;
  try {
    await store.remove(key);
  } catch {
    // Nothing to forget when the store cannot be written.
  }
}

// Asks for read permission and reads the file. The permission request is the first thing this
// function does, so a caller that invokes it from a click handler keeps the user's gesture. Gives
// undefined when there is no handle, permission is refused, or the file cannot be read (it moved):
// the caller then opens the picker.
export async function reopenFromHandle(
  handle: StoredFileHandle | undefined,
): Promise<File | undefined> {
  if (handle === undefined) return undefined;
  try {
    const permission = await handle.requestPermission({ mode: 'read' });
    if (permission !== 'granted') return undefined;
    return await handle.getFile();
  } catch {
    return undefined;
  }
}

// Deletes the whole recent-handle database ("Clear all local data"). True when it is gone, or
// when this browser never had one; false when the delete fails. It never throws.
export async function deleteRecentHandleDatabase(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<boolean> {
  if (!factory) return true;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase(RECENT_HANDLE_DB);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false;
  }
}

// The File System Access picker, where the browser has it (Chromium). Undefined elsewhere.
export interface PickerWindow {
  showOpenFilePicker?(options: {
    multiple: boolean;
    types: { description: string; accept: Record<string, string[]> }[];
    startIn?: StoredFileHandle;
  }): Promise<StoredFileHandle[]>;
}

export function filePickerOf(win: Window): PickerWindow['showOpenFilePicker'] {
  const picker = (win as Window & PickerWindow).showOpenFilePicker;
  return typeof picker === 'function' ? picker : undefined;
}
