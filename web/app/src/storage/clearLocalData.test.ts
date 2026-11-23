import { describe, expect, it, vi } from 'vitest';
import { isSecretKey } from '../prefs/store';
import {
  clearDataAndNotify,
  clearLocalData,
  type ClearOutcome,
  LOCAL_DATA_FOLDERS,
  LOCAL_STORAGE_PREFIX,
} from './clearLocalData';
import type { BlobLike, DirectoryLike, FileLike, WritableLike } from './opfs';
import { StorageUnsupportedError } from './opfs';
import { createFontStore, FONTS_FOLDER } from './fontStore';
import { MemoryDir as TreeDir, memoryRoot } from './testRoot';

// An in-memory Storage, enough for clearLocalData (length, key, removeItem).
class MemoryStorage {
  readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function asStorage(memory: MemoryStorage): Storage {
  return memory as unknown as Storage;
}

function notFound(): DOMException {
  return new DOMException('not found', 'NotFoundError');
}

class MemoryFile implements FileLike {
  async getFile(): Promise<BlobLike> {
    return { size: 0, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
  }

  async createWritable(): Promise<WritableLike> {
    return { write: async () => undefined, close: async () => undefined };
  }
}

// An in-memory directory: removeEntry drops a named folder or file, recursively when asked.
class MemoryDir implements DirectoryLike {
  readonly dirs = new Map<string, MemoryDir>();
  readonly files = new Map<string, MemoryFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike> {
    let dir = this.dirs.get(name);
    if (dir === undefined) {
      if (options?.create !== true) throw notFound();
      dir = new MemoryDir();
      this.dirs.set(name, dir);
    }
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileLike> {
    let file = this.files.get(name);
    if (file === undefined) {
      if (options?.create !== true) throw notFound();
      file = new MemoryFile();
      this.files.set(name, file);
    }
    return file;
  }

  async removeEntry(name: string): Promise<void> {
    if (this.files.delete(name)) return;
    if (!this.dirs.delete(name)) throw notFound();
  }
}

// A root with the folders Elanero uses, one unrelated folder and a file in the root.
function populatedRoot(): MemoryDir {
  const root = new MemoryDir();
  for (const name of ['autosave', 'fonts', 'secrets', 'unrelated']) {
    root.dirs.set(name, new MemoryDir());
  }
  root.files.set('root.txt', new MemoryFile());
  return root;
}

function populatedStorage(): MemoryStorage {
  const memory = new MemoryStorage();
  memory.setItem('elanero.prefs', '{}');
  memory.setItem('elanero.theme', 'dark');
  memory.setItem('elanero.recentFiles', '[]');
  memory.setItem('elanero.x', '1');
  memory.setItem('other.key', 'keep');
  return memory;
}

describe('clearLocalData: localStorage', () => {
  it('removes every elanero.* key and keeps the other keys on the origin', async () => {
    const memory = populatedStorage();
    const outcome = await clearLocalData({
      storage: () => asStorage(memory),
      root: async () => populatedRoot(),
    });
    expect(outcome).toEqual({ keysRemoved: 4, complete: true });
    expect([...memory.data.keys()]).toEqual(['other.key']);
  });

  it('removes keys found after a removal shifts the indexes', async () => {
    const memory = new MemoryStorage();
    for (let i = 0; i < 6; i += 1) memory.setItem(`elanero.k${i}`, 'v');
    memory.setItem('other.a', 'v');
    memory.setItem('elanero.k6', 'v');
    const outcome = await clearLocalData({
      storage: () => asStorage(memory),
      root: async () => new MemoryDir(),
    });
    expect(outcome.keysRemoved).toBe(7);
    expect([...memory.data.keys()]).toEqual(['other.a']);
  });

  it('reports incomplete and does not throw when localStorage throws', async () => {
    const outcome = await clearLocalData({
      storage: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      root: async () => new MemoryDir(),
    });
    expect(outcome).toEqual({ keysRemoved: 0, complete: false });
  });

  it('reports incomplete when removeItem throws, and still runs the folder step', async () => {
    const memory = populatedStorage();
    memory.removeItem = () => {
      throw new DOMException('quota', 'InvalidStateError');
    };
    const root = populatedRoot();
    const outcome = await clearLocalData({
      storage: () => asStorage(memory),
      root: async () => root,
    });
    expect(outcome.complete).toBe(false);
    expect(root.dirs.has('fonts')).toBe(false);
  });

  it('never treats an elanero key as a secret, so the prefix is safe to clear', () => {
    for (const key of ['elanero.theme', 'elanero.prefs', 'elanero.recentFiles']) {
      expect(isSecretKey(key)).toBe(false);
      expect(key.startsWith(LOCAL_STORAGE_PREFIX)).toBe(true);
    }
  });
});

describe('clearLocalData: OPFS folders', () => {
  it('removes fonts/ and secrets/, keeps autosave/ and unrelated folders', async () => {
    const root = populatedRoot();
    const outcome = await clearLocalData({
      storage: () => asStorage(new MemoryStorage()),
      root: async () => root,
    });
    expect(outcome.complete).toBe(true);
    expect(root.dirs.has('fonts')).toBe(false);
    expect(root.dirs.has('secrets')).toBe(false);
    // Another open tab keeps its recovery copies in autosave/.
    expect(root.dirs.has('autosave')).toBe(true);
    expect(root.dirs.has('unrelated')).toBe(true);
    expect(root.files.has('root.txt')).toBe(true);
  });

  it('removes the fonts a font store kept, so Clear all leaves no kept font behind', async () => {
    const root = new TreeDir();
    const store = createFontStore(memoryRoot(root), async () => ({ quota: 10_000, usage: 0 }));
    const id = 'c'.repeat(64);
    const kept = await store.write(
      { id, name: 'c.ttf', size: 3, fontFormat: 'truetype', added: '2026-01-01T00:00:00.000Z' },
      new Blob(['ccc']),
    );
    expect(kept).toBe('kept');
    expect(root.dirs.has(FONTS_FOLDER)).toBe(true);

    const outcome = await clearLocalData({
      storage: () => asStorage(new MemoryStorage()),
      root: memoryRoot(root),
    });

    expect(outcome.complete).toBe(true);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('lists exactly the folders it removes, and never autosave', () => {
    expect([...LOCAL_DATA_FOLDERS]).toEqual(['fonts', 'secrets']);
    expect(LOCAL_DATA_FOLDERS).not.toContain('autosave');
  });

  it('treats a missing folder as already removed', async () => {
    const root = new MemoryDir();
    const outcome = await clearLocalData({
      storage: () => asStorage(new MemoryStorage()),
      root: async () => root,
    });
    expect(outcome.complete).toBe(true);
  });

  it('reports incomplete when a folder cannot be removed, without throwing', async () => {
    const root = new MemoryDir();
    root.dirs.set('fonts', new MemoryDir());
    root.removeEntry = async () => {
      throw new DOMException('locked', 'NoModificationAllowedError');
    };
    const outcome = await clearLocalData({
      storage: () => asStorage(new MemoryStorage()),
      root: async () => root,
    });
    expect(outcome.complete).toBe(false);
  });

  it('clears localStorage and reports complete when the browser has no private storage', async () => {
    const memory = populatedStorage();
    const outcome = await clearLocalData({
      storage: () => asStorage(memory),
      root: () => Promise.reject(new StorageUnsupportedError('no OPFS')),
    });
    expect(outcome).toEqual({ keysRemoved: 4, complete: true });
    expect([...memory.data.keys()]).toEqual(['other.key']);
  });

  it('reports incomplete, without throwing, when opening the private root fails otherwise', async () => {
    const outcome = await clearLocalData({
      storage: () => asStorage(new MemoryStorage()),
      root: () => Promise.reject(new Error('disk gone')),
    });
    expect(outcome.complete).toBe(false);
  });
});

describe('clear and notify the other tabs', () => {
  const done: ClearOutcome = { keysRemoved: 0, complete: true };
  const partial: ClearOutcome = { keysRemoved: 0, complete: false };

  it('tells the other tabs about the fonts once a clear is complete', async () => {
    const fonts = { cleared: vi.fn() };
    const outcome = await clearDataAndNotify(async () => done, fonts);

    expect(outcome).toEqual(done);
    expect(fonts.cleared).toHaveBeenCalledTimes(1);
  });

  it('does not tell the other tabs when a clear is incomplete, and still returns the outcome', async () => {
    const fonts = { cleared: vi.fn() };
    const outcome = await clearDataAndNotify(async () => partial, fonts);

    expect(outcome).toEqual(partial);
    expect(fonts.cleared).not.toHaveBeenCalled();
  });

  it('clears without a font library, as the Preferences dialog does when none is open', async () => {
    await expect(clearDataAndNotify(async () => done, undefined)).resolves.toEqual(done);
  });
});
