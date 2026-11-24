import { describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { StorageUnsupportedError, type DirectoryLike, type FileLike } from '../storage/opfs';
import { createStampStore, STAMPS_FOLDER, type StampStore } from '../storage/stampStore';
import { MemoryDir, memoryRoot, notFound } from '../storage/testRoot';
import {
  createStampLibrary,
  MAX_IMAGE_PIXELS,
  MAX_LIBRARY_BYTES,
  MAX_STAMP_BYTES,
  MAX_STAMPS,
  refusalText,
  stampLabel,
  type StampLibrary,
} from './stampLibrary';

const roomy = async () => ({ quota: 1e9, usage: 0 });
const MIB = 1024 * 1024;

// A PNG header of the given size, with a salt byte so each call makes a different picture.
function png(width: number, height: number, salt = 0, name = 'seal.png'): File {
  const bytes = new Uint8Array(34);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[33] = salt;
  return new File([bytes], name, { type: 'image/png' });
}

function libraryOn(
  root: () => Promise<DirectoryLike>,
  estimate: () => Promise<{ quota?: number; usage?: number }> = roomy,
  extra: Partial<Parameters<typeof createStampLibrary>[0]> = {},
): { library: StampLibrary; persist: ReturnType<typeof vi.fn>; store: StampStore } {
  const store = createStampStore(root, estimate);
  const persist = vi.fn(async () => undefined);
  return { library: createStampLibrary({ store, persist, ...extra }), persist, store };
}

function library(extra: Partial<Parameters<typeof createStampLibrary>[0]> = {}) {
  return libraryOn(memoryRoot(new MemoryDir()), roomy, extra);
}

// What the fake root holds: its folders, and the files in the stamps folder. A refusal must leave
// both as they were.
interface Snapshot {
  readonly folders: string[];
  readonly names: string[];
}

function snapshot(dir: MemoryDir): Snapshot {
  const stamps = dir.dirs.get(STAMPS_FOLDER);
  return {
    folders: [...dir.dirs.keys()].sort(),
    names: stamps === undefined ? [] : [...stamps.files.keys()].sort(),
  };
}

describe('stampLibrary', () => {
  it('keeps a PNG and lists it with its label, type and size', async () => {
    const { library: lib, persist } = library();
    const outcome = await lib.add(png(400, 200, 0, 'Company_seal.png'));
    expect(outcome.kind).toBe('added');
    expect(await lib.list()).toEqual([
      expect.objectContaining({
        label: 'Company seal',
        type: 'png',
        width: 400,
        height: 200,
        kept: true,
      }),
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    await lib.add(png(10, 10, 1));
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('labels a file with no usable name "stamp" and caps a long one', () => {
    expect(stampLabel('.png')).toBe('stamp');
    expect(stampLabel('   .jpg')).toBe('stamp');
    expect(stampLabel('a'.repeat(150) + '.png')).toHaveLength(100);
    expect(stampLabel('  two__words .jpeg ')).toBe('two  words');
  });

  it('refuses a file over 20 MiB before reading it, and writes nothing', async () => {
    const dir = new MemoryDir();
    const { library: lib, persist } = libraryOn(memoryRoot(dir));
    const before = snapshot(dir);
    const big = new File([new Uint8Array(MAX_STAMP_BYTES + 1)], 'big.png');
    const arrayBuffer = vi.spyOn(big, 'arrayBuffer');
    expect(await lib.add(big)).toEqual({ kind: 'refused', reason: 'tooLarge' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(snapshot(dir)).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
    expect(refusalText('tooLarge')).toBe(t('stamp.custom.tooLarge', { mb: 20 }));
  });

  it('checks the size before the type: a huge file that is not an image is tooLarge', async () => {
    const { library: lib } = library();
    const big = new File([new Uint8Array(MAX_STAMP_BYTES + 1)], 'huge.txt');
    expect(await lib.add(big)).toEqual({ kind: 'refused', reason: 'tooLarge' });
  });

  it('refuses bytes that are not a PNG or JPEG, and writes nothing', async () => {
    const dir = new MemoryDir();
    const { library: lib, persist } = libraryOn(memoryRoot(dir));
    const before = snapshot(dir);
    const text = new File(['hello, not an image'], 'note.png');
    expect(await lib.add(text)).toEqual({ kind: 'refused', reason: 'wrongType' });
    expect(refusalText('wrongType')).toBe(t('stamp.custom.wrongType'));
    expect(await lib.list()).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
  });

  it('refuses a picture over 25 MP, and accepts exactly 25 MP', async () => {
    const dir = new MemoryDir();
    const { library: lib, persist } = libraryOn(memoryRoot(dir));
    const before = snapshot(dir);
    expect(await lib.add(png(6000, 5000))).toEqual({ kind: 'refused', reason: 'tooManyPixels' });
    expect(snapshot(dir)).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
    expect(refusalText('tooManyPixels')).toBe(t('stamp.custom.tooManyPixels'));
    expect((await lib.add(png(5000, 5000, 2))).kind).toBe('added');
    expect(MAX_IMAGE_PIXELS).toBe(25_000_000);
  });

  it('keeps one stamp for a picture added twice, whatever its name', async () => {
    const { library: lib } = library();
    const first = await lib.add(png(20, 20, 3, 'one.png'));
    const again = await lib.add(png(20, 20, 3, 'two.png'));
    expect(first.kind).toBe('added');
    expect(again).toMatchObject({ kind: 'already', stamp: { label: 'one' } });
    expect(await lib.list()).toHaveLength(1);
    expect(refusalText('libraryFull')).toBe(t('stamp.custom.libraryFull'));
  });

  it('answers already, not libraryFull, for a kept picture at the stamp limit', async () => {
    const { library: lib } = library({ limits: { maxStamps: 1, maxBytes: 10 * MIB } });
    await lib.add(png(4, 4, 1, 'one.png'));
    expect(await lib.add(png(4, 4, 1, 'again.png'))).toMatchObject({
      kind: 'already',
      stamp: { label: 'one' },
    });
    // A different picture is still refused at the limit.
    expect(await lib.add(png(4, 4, 2))).toEqual({ kind: 'refused', reason: 'libraryFull' });
  });

  it('refuses a new picture at the stamp limit without writing it', async () => {
    const dir = new MemoryDir();
    const { library: lib, persist } = libraryOn(memoryRoot(dir), roomy, {
      limits: { maxStamps: 1, maxBytes: 10 * MIB },
    });
    await lib.add(png(4, 4, 1));
    const before = snapshot(dir);
    const persisted = persist.mock.calls.length;
    expect(await lib.add(png(4, 4, 2))).toEqual({ kind: 'refused', reason: 'libraryFull' });
    expect(snapshot(dir)).toEqual(before);
    expect(persist).toHaveBeenCalledTimes(persisted);
  });

  it('refuses past the stamp count and past the byte total', async () => {
    const counted = library({ limits: { maxStamps: 2, maxBytes: 10 * MIB } });
    await counted.library.add(png(4, 4, 1));
    await counted.library.add(png(4, 4, 2));
    expect(await counted.library.add(png(4, 4, 3))).toEqual({
      kind: 'refused',
      reason: 'libraryFull',
    });

    // Each PNG here is 34 bytes: the second would take the total to 68, past 60.
    const sized = library({ limits: { maxStamps: 64, maxBytes: 60 } });
    expect((await sized.library.add(png(4, 4, 1))).kind).toBe('added');
    expect(await sized.library.add(png(4, 4, 2))).toEqual({
      kind: 'refused',
      reason: 'libraryFull',
    });
  });

  it('keeps the library limits at 64 stamps and 256 MiB', () => {
    expect(MAX_STAMPS).toBe(64);
    expect(MAX_LIBRARY_BYTES).toBe(256 * MIB);
  });

  it('holds a stamp for this tab when the disk has no room for it', async () => {
    const { library: lib } = libraryOn(memoryRoot(new MemoryDir()), async () => ({
      quota: 10,
      usage: 9,
    }));
    const outcome = await lib.add(png(8, 8, 1));
    expect(outcome).toMatchObject({ kind: 'held', reason: 'noSpace' });
    expect(await lib.list()).toEqual([expect.objectContaining({ kept: false })]);
    expect(await lib.storage()).toBe('persistent');
  });

  it('holds a stamp for this tab when the write fails', async () => {
    const { library: lib } = libraryOn(memoryRoot(new MemoryDir()), async () => {
      throw new Error('estimate refused');
    });
    expect(await lib.add(png(8, 8, 1))).toMatchObject({ kind: 'held', reason: 'failed' });
  });

  it('goes to session mode when the browser has no private storage', async () => {
    const { library: lib } = libraryOn(async () => {
      throw new StorageUnsupportedError('no OPFS');
    });
    const outcome = await lib.add(png(8, 8, 1));
    expect(outcome).toMatchObject({ kind: 'held', reason: 'unsupported' });
    expect(await lib.storage()).toBe('session');
    const id = outcome.kind === 'held' ? outcome.stamp.id : '';
    expect((await lib.read(id))?.size).toBe(34);
  });

  it('in session mode, asks for nothing and creates no folder', async () => {
    const creates: string[] = [];
    const folder: DirectoryLike = {
      getDirectoryHandle: async (name, options) => {
        if (options?.create === true) creates.push(name);
        return folder;
      },
      getFileHandle: async () => {
        throw notFound();
      },
      removeEntry: async () => undefined,
      // No keys(): the folder cannot be listed, so the store is unavailable.
    };
    const { library: lib, persist } = libraryOn(async () => folder);
    expect(await lib.add(png(8, 8, 1))).toMatchObject({ kind: 'held', reason: 'unsupported' });
    expect(await lib.storage()).toBe('session');
    expect(persist).not.toHaveBeenCalled();
    expect(creates).toEqual([]);
  });

  it('goes to session mode when the browser cannot write a file', async () => {
    const folder: DirectoryLike = {
      getDirectoryHandle: async () => folder,
      getFileHandle: async () =>
        ({ getFile: () => Promise.reject(new Error('none')) }) as unknown as FileLike,
      removeEntry: async () => undefined,
      keys: async function* () {},
    };
    const { library: lib } = libraryOn(async () => folder);
    expect(await lib.add(png(8, 8, 1))).toMatchObject({ kind: 'held', reason: 'unsupported' });
    expect(await lib.storage()).toBe('session');
  });

  it('removes a kept stamp: it leaves the list and cannot be read', async () => {
    const { library: lib } = library();
    const added = await lib.add(png(8, 8, 1));
    const id = added.kind === 'added' ? added.stamp.id : '';
    expect(await lib.remove(id)).toBe(true);
    expect(await lib.list()).toEqual([]);
    expect(await lib.read(id)).toBeUndefined();
  });

  it('removes a held stamp the same way', async () => {
    const { library: lib } = libraryOn(async () => {
      throw new StorageUnsupportedError('no OPFS');
    });
    const added = await lib.add(png(8, 8, 1));
    const id = added.kind === 'held' ? added.stamp.id : '';
    expect(await lib.remove(id)).toBe(true);
    expect(await lib.list()).toEqual([]);
  });

  it('reports false when the store cannot remove a stamp', async () => {
    const store = createStampStore(memoryRoot(new MemoryDir()), roomy);
    const lib = createStampLibrary({ store: { ...store, remove: async () => false } });
    const added = await lib.add(png(8, 8, 1));
    const id = added.kind === 'added' ? added.stamp.id : '';
    expect(await lib.remove(id)).toBe(false);
  });
});
