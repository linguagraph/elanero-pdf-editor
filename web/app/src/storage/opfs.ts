// The browser's private file system (Origin Private File System, W1.1 section 6). The app uses it
// for one thing: the autosave copy of an open document, so an engine restart can reopen it. Only
// this folder's files are ever touched, and only through the small interfaces below, so the store
// and its tests do not need a real browser. Every call here can fail (no OPFS in an old browser, a
// private window, blocked site data, a full disk), so callers wrap each one in try/catch.

// The parts of a file-system handle the store uses. The browser's handles satisfy them.
export interface BlobLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface WritableLike {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface FileLike {
  getFile(): Promise<BlobLike>;
  createWritable(): Promise<WritableLike>;
}

export interface DirectoryLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export interface StorageEstimateLike {
  readonly quota?: number;
  readonly usage?: number;
}

// The browser's private root, or a rejection when the browser has no OPFS.
export function privateRoot(): Promise<DirectoryLike> {
  try {
    const storage = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } })
      .navigator?.storage;
    if (typeof storage?.getDirectory !== 'function') {
      return Promise.reject(new Error('the browser has no private file storage'));
    }
    return (storage.getDirectory as () => Promise<DirectoryLike>).call(storage);
  } catch (error) {
    return Promise.reject(error);
  }
}

// The storage estimate, or undefined when the browser does not give one. A missing estimate is not
// a refusal: the write still goes ahead, and a full disk then fails the write itself.
export async function storageEstimate(): Promise<StorageEstimateLike | undefined> {
  try {
    const storage = (globalThis as { navigator?: { storage?: { estimate?: unknown } } }).navigator
      ?.storage;
    if (typeof storage?.estimate !== 'function') return undefined;
    return await (storage.estimate as () => Promise<StorageEstimateLike>).call(storage);
  } catch {
    return undefined;
  }
}
