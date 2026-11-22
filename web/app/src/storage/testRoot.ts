// An in-memory stand-in for the browser's private root (OPFS), for the storage tests. It keeps the
// same rules the browser does: a missing folder is a NotFoundError, a removed folder takes its files,
// and a writable stream commits on close. Only tests import it; the app never does.
import type { BlobLike, DirectoryLike, FileLike, WritableLike } from './opfs';

export function notFound(): DOMException {
  return new DOMException('not found', 'NotFoundError');
}

async function bytesOf(data: Blob): Promise<ArrayBuffer> {
  return data.arrayBuffer();
}

interface Stored {
  data: Blob;
  modified: number;
}

export class MemoryDir implements DirectoryLike {
  readonly dirs = new Map<string, MemoryDir>();
  readonly files = new Map<string, Stored>();

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
    if (!this.files.has(name)) {
      if (options?.create !== true) throw notFound();
      this.files.set(name, { data: new Blob([]), modified: Date.now() });
    }
    return new MemoryFile(this, name);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const dir = this.dirs.get(name);
    if (dir !== undefined) {
      if (dir.dirs.size + dir.files.size > 0 && options?.recursive !== true) {
        throw new DOMException('not empty', 'InvalidModificationError');
      }
      this.dirs.delete(name);
      return;
    }
    if (!this.files.delete(name)) throw notFound();
  }

  keys(): AsyncIterable<string> {
    const names = [...this.dirs.keys(), ...this.files.keys()];
    return (async function* () {
      yield* names;
    })();
  }
}

class MemoryFile implements FileLike {
  constructor(
    private readonly dir: MemoryDir,
    private readonly name: string,
  ) {}

  async getFile(): Promise<BlobLike> {
    const stored = this.dir.files.get(this.name);
    if (stored === undefined) throw notFound();
    const { data, modified } = stored;
    return {
      size: data.size,
      lastModified: modified,
      arrayBuffer: () => bytesOf(data),
      text: () => data.text(),
    };
  }

  async createWritable(): Promise<WritableLike> {
    let pending: Blob = new Blob([]);
    return {
      write: async (data: Blob) => {
        pending = data;
      },
      close: async () => {
        this.dir.files.set(this.name, { data: pending, modified: Date.now() });
      },
    };
  }
}

// A root whose folder is the given directory.
export function memoryRoot(dir: MemoryDir = new MemoryDir()): () => Promise<DirectoryLike> {
  return async () => dir;
}
