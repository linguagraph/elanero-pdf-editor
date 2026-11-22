import { describe, expect, it } from 'vitest';
import { createFontStore, FONTS_FOLDER, ORPHAN_AGE_MS, type StoredFontRecord } from './fontStore';
import { LOCAL_DATA_FOLDERS } from './clearLocalData';
import { MemoryDir, memoryRoot, notFound } from './testRoot';
import { type DirectoryLike, type FileLike, StorageUnsupportedError } from './opfs';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

function record(id: string, added: string, size = 3): StoredFontRecord {
  return { id, name: `${id.slice(0, 1)}.ttf`, size, fontFormat: 'truetype', added };
}

// The same directory with its files changed by `change`. Unless `listable` is false it keeps `keys`,
// so the store can list it; a root without `keys` is the case the store must refuse.
function withFiles(
  dir: DirectoryLike,
  change: (file: FileLike) => FileLike,
  listable = true,
): DirectoryLike {
  const wrapped: DirectoryLike = {
    getDirectoryHandle: async (name, options) =>
      withFiles(await dir.getDirectoryHandle(name, options), change),
    getFileHandle: async (name, options) => change(await dir.getFileHandle(name, options)),
    removeEntry: (name, options) => dir.removeEntry(name, options),
  };
  if (!listable || typeof dir.keys !== 'function') return wrapped;
  return { ...wrapped, keys: dir.keys.bind(dir) };
}

// A browser that refuses every write with a full disk.
function fullDisk(file: FileLike): FileLike {
  return {
    getFile: () => file.getFile(),
    createWritable: async () => ({
      write: async () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      close: async () => undefined,
    }),
  };
}

// A file handle from an older Safari, which has no createWritable.
function noWritable(file: FileLike): FileLike {
  return { getFile: () => file.getFile() } as unknown as FileLike;
}

function bytes(text: string): Blob {
  return new Blob([text]);
}

// The folder the store writes, read back from the memory root.
function fontsOf(root: MemoryDir): MemoryDir {
  const folder = root.dirs.get(FONTS_FOLDER);
  if (folder === undefined) throw new Error('no fonts folder');
  return folder;
}

const estimate = async () => ({ quota: 10_000, usage: 0 });

describe('font store', () => {
  it('keeps a font as bytes plus a record, and lists it back in order', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);

    expect(await store.write(record(ID_B, '2026-01-02T00:00:00.000Z'), bytes('bbb'))).toBe('kept');
    expect(await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'))).toBe('kept');

    expect([...fontsOf(root).files.keys()].sort()).toEqual(
      [`${ID_A}.font`, `${ID_A}.json`, `${ID_B}.font`, `${ID_B}.json`].sort(),
    );
    const listed = await store.list();
    expect(listed.map((item) => item.id)).toEqual([ID_A, ID_B]);
    expect(listed[0]).toMatchObject({ name: 'a.ttf', size: 3, fontFormat: 'truetype' });
    expect(await (await store.read(ID_A))?.text()).toBe('aaa');
  });

  it('lists nothing when no font was kept, and nothing when the folder cannot be listed', async () => {
    const store = createFontStore(memoryRoot(new MemoryDir()), estimate);
    expect(await store.list()).toEqual([]);
    expect(await store.available()).toBe(true);

    const noKeys = new MemoryDir();
    noKeys.dirs.set(FONTS_FOLDER, new MemoryDir());
    const unlistable = createFontStore(memoryRoot(noKeys), estimate);
    (noKeys.dirs.get(FONTS_FOLDER) as { keys?: unknown }).keys = undefined;
    expect(await unlistable.list()).toEqual([]);
    expect(await unlistable.available()).toBe(false);
  });

  it('refuses to keep a font on a root that cannot list its folders, and writes nothing', async () => {
    const inner = new MemoryDir();
    const root = withFiles(inner, (file) => file, false);
    const store = createFontStore(async () => root, estimate);

    expect(await store.available()).toBe(false);
    expect(await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'))).toBe(
      'unsupported',
    );
    expect(inner.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('gives no-space when the disk refuses the write as full', async () => {
    const root = withFiles(new MemoryDir(), fullDisk);
    const store = createFontStore(async () => root, estimate);
    expect(await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'))).toBe(
      'no-space',
    );
  });

  it('gives unsupported when the browser cannot write a file, and keeps nothing', async () => {
    const inner = new MemoryDir();
    const root = withFiles(inner, noWritable);
    const store = createFontStore(async () => root, estimate);
    expect(await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'))).toBe(
      'unsupported',
    );
    expect(await store.list()).toEqual([]);
  });

  it('skips a record whose bytes are missing or the wrong size, and a name that is not an id', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    await store.write(record(ID_A, '2026-01-01T00:00:00.000Z', 3), bytes('aaa'));
    await store.write(record(ID_B, '2026-01-02T00:00:00.000Z', 3), bytes('bbb'));
    fontsOf(root).files.set(`${ID_B}.font`, { data: bytes('bbbbbb'), modified: Date.now() });
    fontsOf(root).files.set('notes.json', { data: bytes('{}'), modified: Date.now() });

    expect((await store.list()).map((item) => item.id)).toEqual([ID_A]);
  });

  it('deletes an old bytes file with no record, and leaves a young one', async () => {
    const root = new MemoryDir();
    const folder = fontsOf(await seeded(root));
    folder.files.set(`${ID_A}.font`, {
      data: bytes('old'),
      modified: Date.now() - ORPHAN_AGE_MS - 1,
    });
    folder.files.set(`${ID_B}.font`, { data: bytes('new'), modified: Date.now() });
    const store = createFontStore(memoryRoot(root), estimate);

    await store.list();

    expect(folder.files.has(`${ID_A}.font`)).toBe(false);
    expect(folder.files.has(`${ID_B}.font`)).toBe(true);
  });

  it('refuses a write that does not fit the quota, and reports an unsupported browser', async () => {
    const tight = createFontStore(memoryRoot(new MemoryDir()), async () => ({
      quota: 10,
      usage: 0,
    }));
    expect(await tight.write(record(ID_A, '2026-01-01T00:00:00.000Z', 6), bytes('aaaaaa'))).toBe(
      'no-space',
    );

    const none = createFontStore(async () => {
      throw new StorageUnsupportedError('no storage');
    }, estimate);
    expect(await none.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'))).toBe(
      'unsupported',
    );
    expect(await none.available()).toBe(false);
    expect(await none.list()).toEqual([]);
  });

  it('removes a font and its folder when it was the last one, but keeps the folder for another', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'));
    await store.write(record(ID_B, '2026-01-02T00:00:00.000Z'), bytes('bbb'));

    expect(await store.remove(ID_A)).toBe(true);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(true);
    expect(await store.remove(ID_B)).toBe(true);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(await store.remove(ID_B)).toBe(true);
    expect(await store.remove('not-an-id')).toBe(false);
  });

  it('removes every kept font with the folder, and an absent folder counts as removed', async () => {
    const root = new MemoryDir();
    const store = createFontStore(memoryRoot(root), estimate);
    expect(await store.removeAll()).toBe(true);
    await store.write(record(ID_A, '2026-01-01T00:00:00.000Z'), bytes('aaa'));

    expect(await store.removeAll()).toBe(true);
    expect(root.dirs.has(FONTS_FOLDER)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('is one of the folders Clear all removes', () => {
    expect(LOCAL_DATA_FOLDERS).toContain(FONTS_FOLDER);
  });

  it('never throws, whatever the browser answers', async () => {
    const broken = createFontStore(async () => {
      throw notFound();
    }, estimate);
    expect(await broken.read(ID_A)).toBeUndefined();
    expect(await broken.remove(ID_A)).toBe(false);
    expect(await broken.removeAll()).toBe(true);
  });
});

// A root that already holds one kept font, so the folder exists.
async function seeded(root: MemoryDir): Promise<MemoryDir> {
  await createFontStore(memoryRoot(root), estimate).write(
    record(ID_B, '2026-01-02T00:00:00.000Z'),
    bytes('bbb'),
  );
  return root;
}
