import { describe, expect, it } from 'vitest';
import type { AutosaveMeta } from './autosaveStore';
import { createAutosaveStore, fitsQuota } from './autosaveStore';
import type { BlobLike, DirectoryLike, FileLike, StorageEstimateLike, WritableLike } from './opfs';

// The bytes of a Blob. FileReader is used because jsdom's Blob is not the one Response reads.
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

// An in-memory stand-in for the browser's private folder tree. A write lands only on close(), as the
// browser's writable streams do, so a cut-off write never replaces the old file.
class MemoryFile implements FileLike {
  bytes: Uint8Array = new Uint8Array();

  async getFile(): Promise<BlobLike> {
    const bytes = this.bytes;
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async createWritable(): Promise<WritableLike> {
    const parts: Uint8Array[] = [];
    return {
      write: async (data: Blob) => {
        parts.push(new Uint8Array(await readBlob(data)));
      },
      close: async () => {
        const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          joined.set(part, offset);
          offset += part.byteLength;
        }
        this.bytes = joined;
      },
    };
  }
}

function notFound(): DOMException {
  return new DOMException('not found', 'NotFoundError');
}

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

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    if (this.files.delete(name)) return;
    const dir = this.dirs.get(name);
    if (dir === undefined) throw notFound();
    if (dir.dirs.size + dir.files.size > 0 && options?.recursive !== true) {
      throw new DOMException('not empty', 'InvalidModificationError');
    }
    this.dirs.delete(name);
  }
}

const META: AutosaveMeta = { name: 'report.pdf', time: '2026-11-19T10:00:00.000Z', pages: 3 };

function bytesOf(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function textOf(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

function storeOn(
  root: MemoryDir,
  estimate: () => Promise<StorageEstimateLike | undefined> = async () => undefined,
) {
  return createAutosaveStore(async () => root, estimate);
}

describe('fitsQuota', () => {
  it('needs twice the copy size free', () => {
    expect(fitsQuota(100, { quota: 1000, usage: 800 })).toBe(true);
    expect(fitsQuota(100, { quota: 1000, usage: 801 })).toBe(false);
  });

  it('does not refuse when the browser gives no estimate', () => {
    expect(fitsQuota(100, undefined)).toBe(true);
    expect(fitsQuota(100, { quota: 1000 })).toBe(true);
  });
});

describe('autosave store', () => {
  it('writes a copy and reads it back with its metadata', async () => {
    const root = new MemoryDir();
    const store = storeOn(root);
    expect(await store.write('tab-a', 7, bytesOf('%PDF copy'), META)).toBe('written');
    const copy = await store.read('tab-a', 7);
    expect(copy).toBeDefined();
    expect(textOf(copy?.bytes ?? new ArrayBuffer(0))).toBe('%PDF copy');
    expect(copy?.meta).toEqual(META);
  });

  it('reads nothing when there is no copy', async () => {
    expect(await storeOn(new MemoryDir()).read('tab-a', 1)).toBeUndefined();
  });

  it('ignores a .pdf that has no .json beside it', async () => {
    const root = new MemoryDir();
    const autosave = await root.getDirectoryHandle('autosave', { create: true });
    const tab = await autosave.getDirectoryHandle('tab-a', { create: true });
    const pdf = await tab.getFileHandle('1.pdf', { create: true });
    const writable = await pdf.createWritable();
    await writable.write(new Blob(['%PDF']));
    await writable.close();
    expect(await storeOn(root).read('tab-a', 1)).toBeUndefined();
  });

  it('ignores a copy whose size differs from the one its .json recorded', async () => {
    const root = new MemoryDir();
    const store = storeOn(root);
    await store.write('tab-a', 2, bytesOf('first version'), META);
    // A second write that was cut off: the .pdf is shorter than the .json says.
    const autosave = await root.getDirectoryHandle('autosave');
    const tab = await autosave.getDirectoryHandle('tab-a');
    const pdf = await tab.getFileHandle('2.pdf');
    const writable = await pdf.createWritable();
    await writable.write(new Blob(['cut']));
    await writable.close();
    expect(await store.read('tab-a', 2)).toBeUndefined();
  });

  it('refuses a copy that does not fit the estimate, and writes nothing', async () => {
    const root = new MemoryDir();
    const store = storeOn(root, async () => ({ quota: 100, usage: 90 }));
    expect(await store.write('tab-a', 3, bytesOf('0123456789'), META)).toBe('no-space');
    expect(await store.read('tab-a', 3)).toBeUndefined();
  });

  it('reports no space when the disk refuses the write', async () => {
    const quotaRoot: DirectoryLike = {
      getDirectoryHandle: async () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      getFileHandle: async () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeEntry: async () => undefined,
    };
    const store = createAutosaveStore(async () => quotaRoot);
    expect(await store.write('tab-a', 4, bytesOf('x'), META)).toBe('no-space');
  });

  it('reports unavailable without throwing when the browser has no private storage', async () => {
    const store = createAutosaveStore(async () => {
      throw new Error('no OPFS');
    });
    expect(await store.available()).toBe(false);
    expect(await store.write('tab-a', 1, bytesOf('x'), META)).toBe('failed');
    expect(await store.read('tab-a', 1)).toBeUndefined();
    await expect(store.remove('tab-a', 1)).resolves.toBeUndefined();
    await expect(store.removeTab('tab-a')).resolves.toBeUndefined();
  });

  it('removes one copy, and removes a whole page load', async () => {
    const root = new MemoryDir();
    const store = storeOn(root);
    await store.write('tab-a', 1, bytesOf('one'), META);
    await store.write('tab-a', 2, bytesOf('two'), META);
    await store.remove('tab-a', 1);
    expect(await store.read('tab-a', 1)).toBeUndefined();
    expect(await store.read('tab-a', 2)).toBeDefined();
    await store.removeTab('tab-a');
    expect(await store.read('tab-a', 2)).toBeUndefined();
  });

  it('keeps one page load apart from another', async () => {
    const root = new MemoryDir();
    const store = storeOn(root);
    await store.write('tab-a', 1, bytesOf('mine'), META);
    await store.write('tab-b', 1, bytesOf('theirs'), META);
    await store.removeTab('tab-b');
    expect(textOf((await store.read('tab-a', 1))?.bytes ?? new ArrayBuffer(0))).toBe('mine');
  });
});
