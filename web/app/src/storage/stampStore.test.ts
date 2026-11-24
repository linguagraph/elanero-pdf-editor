import { describe, expect, it } from 'vitest';
import { ORPHAN_AGE_MS } from './recordStore';
import { createStampStore, STAMPS_FOLDER, type StoredStampRecord } from './stampStore';
import { StorageUnsupportedError, type DirectoryLike, type FileLike } from './opfs';
import { MemoryDir, memoryRoot, notFound } from './testRoot';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);
const roomy = async () => ({ quota: 1e9, usage: 0 });

function stamp(id: string, added = '2026-01-01T00:00:00.000Z', size = 3): StoredStampRecord {
  return { id, label: 'Seal', size, type: 'png', width: 2, height: 2, added };
}

function bytes(text: string): Blob {
  return new Blob([text]);
}

function folderOf(root: MemoryDir): MemoryDir {
  const folder = root.dirs.get(STAMPS_FOLDER);
  if (folder === undefined) throw new Error('no stamps folder');
  return folder;
}

describe('stampStore', () => {
  it('writes the picture and its record, and lists them back in order', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    expect(await store.write(stamp(ID_A, '2026-02-01T00:00:00.000Z'), bytes('aaa'))).toBe('kept');
    expect(await store.write(stamp(ID_B, '2026-01-01T00:00:00.000Z'), bytes('bbb'))).toBe('kept');

    expect([...folderOf(root).files.keys()].sort()).toEqual(
      [`${ID_A}.img`, `${ID_A}.json`, `${ID_B}.img`, `${ID_B}.json`].sort(),
    );
    const listed = await store.list();
    expect(listed.map((record) => record.id)).toEqual([ID_B, ID_A]);
    expect(listed[0]).toMatchObject({ label: 'Seal', type: 'png', width: 2, height: 2 });
  });

  it('reads the picture bytes back, and gives nothing for an unknown id', async () => {
    const store = createStampStore(memoryRoot(new MemoryDir()), roomy);
    await store.write(stamp(ID_A), bytes('pic'));
    expect(await (await store.read(ID_A))?.text()).toBe('pic');
    expect(await store.read(ID_B)).toBeUndefined();
    expect(await store.read('../escape')).toBeUndefined();
  });

  it('does not list a picture with no record, and removes an old orphan', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A), bytes('aaa'));
    const folder = folderOf(root);
    folder.files.set(`${ID_B}.img`, { data: bytes('new'), modified: Date.now() });
    folder.files.set('old.img', { data: bytes('old'), modified: Date.now() - ORPHAN_AGE_MS - 1 });

    expect((await store.list()).map((record) => record.id)).toEqual([ID_A]);
    expect(folder.files.has('old.img')).toBe(false);
    expect(folder.files.has(`${ID_B}.img`)).toBe(true);
  });

  it('does not list a stamp whose picture size differs from its record', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A, undefined, 3), bytes('aaa'));
    folderOf(root).files.set(`${ID_A}.img`, { data: bytes('a'), modified: Date.now() });
    expect(await store.list()).toEqual([]);
  });

  it('skips a record whose type is not png or jpeg', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A), bytes('aaa'));
    const record = { ...stamp(ID_A), type: 'gif' };
    const json = JSON.stringify({ format: 1, ...record });
    folderOf(root).files.set(`${ID_A}.json`, { data: bytes(json), modified: Date.now() });
    folderOf(root).files.set(`${ID_A}.img`, { data: bytes('aaa'), modified: Date.now() });
    expect(await store.list()).toEqual([]);
  });

  it('removes the record, the picture and the empty folder', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A), bytes('aaa'));
    expect(await store.remove(ID_A)).toBe(true);
    expect(root.dirs.has(STAMPS_FOLDER)).toBe(false);
    expect(await store.remove(ID_A)).toBe(true);
    expect(await store.remove('not-an-id')).toBe(false);
  });

  it('keeps the folder when another stamp is still in it', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A), bytes('aaa'));
    await store.write(stamp(ID_B), bytes('bbb'));
    await store.remove(ID_A);
    expect((await store.list()).map((record) => record.id)).toEqual([ID_B]);
  });

  it('reports no-space when the estimate says the picture would not fit', async () => {
    const store = createStampStore(memoryRoot(new MemoryDir()), async () => ({
      quota: 10,
      usage: 9,
    }));
    expect(await store.write(stamp(ID_A), bytes('aaa'))).toBe('no-space');
    expect(await store.list()).toEqual([]);
  });

  it('reports failed when the storage estimate throws', async () => {
    const store = createStampStore(memoryRoot(new MemoryDir()), async () => {
      throw new Error('estimate refused');
    });
    expect(await store.write(stamp(ID_A), bytes('aaa'))).toBe('failed');
  });

  it('reports unsupported when the browser has no private storage', async () => {
    const store = createStampStore(async () => {
      throw new StorageUnsupportedError('no OPFS');
    }, roomy);
    expect(await store.available()).toBe(false);
    expect(await store.write(stamp(ID_A), bytes('aaa'))).toBe('unsupported');
    expect(await store.list()).toEqual([]);
  });

  it('reports unsupported when the browser cannot write a file', async () => {
    const folder: DirectoryLike = {
      getDirectoryHandle: async () => folder,
      // A handle with no createWritable: the older Safari the store must not retry against.
      getFileHandle: async () =>
        ({ getFile: () => Promise.reject(notFound()) }) as unknown as FileLike,
      removeEntry: async () => undefined,
      keys: async function* () {},
    };
    const store = createStampStore(async () => folder, roomy);
    expect(await store.write(stamp(ID_A), bytes('aaa'))).toBe('unsupported');
  });

  it('removes the whole folder with removeAll', async () => {
    const root = new MemoryDir();
    const store = createStampStore(memoryRoot(root), roomy);
    await store.write(stamp(ID_A), bytes('aaa'));
    expect(await store.removeAll()).toBe(true);
    expect(root.dirs.has(STAMPS_FOLDER)).toBe(false);
  });
});
