import { describe, expect, it } from 'vitest';
import { type DirectoryLike } from '../storage/opfs';
import { MemoryDir } from '../storage/testRoot';
import { createRecentThumbs, RECENT_THUMBS_FOLDER, thumbFileName } from './recentThumbs';

function jpeg(text: string): Blob {
  return new Blob([text], { type: 'image/jpeg' });
}

// The folder the store writes to, reached through the same root the store is given.
async function thumbFolder(root: MemoryDir): Promise<MemoryDir> {
  return (await root.getDirectoryHandle(RECENT_THUMBS_FOLDER)) as MemoryDir;
}

describe('recent thumbnails store', () => {
  it('saves a thumbnail and loads it back by file name', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    expect(await store.save('a.pdf', jpeg('AAA'), false)).toBe(true);
    const loaded = await store.load(['a.pdf', 'missing.pdf']);
    expect([...loaded.keys()]).toEqual(['a.pdf']);
    expect(await loaded.get('a.pdf')?.text()).toBe('AAA');
  });

  it('names the file by the sha256 of the recent name, never by the name itself', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    await store.save('secret plan.pdf', jpeg('x'), false);
    const folder = await thumbFolder(root);
    expect([...folder.files.keys()]).toEqual([await thumbFileName('secret plan.pdf')]);
    expect(await thumbFileName('secret plan.pdf')).toMatch(/^[0-9a-f]{64}\.jpg$/);
  });

  it('deletes the thumbnails of names no longer in the list', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    await store.save('a.pdf', jpeg('A'), false);
    await store.save('b.pdf', jpeg('B'), false);
    await store.prune(['b.pdf']);
    const folder = await thumbFolder(root);
    expect([...folder.files.keys()]).toEqual([await thumbFileName('b.pdf')]);
    expect((await store.load(['a.pdf'])).size).toBe(0);
  });

  it('never stores a thumbnail of an encrypted file', async () => {
    const root = new MemoryDir();
    const store = createRecentThumbs(async () => root);
    expect(await store.save('locked.pdf', jpeg('X'), true)).toBe(false);
    expect(root.dirs.has(RECENT_THUMBS_FOLDER)).toBe(false);
    expect((await store.load(['locked.pdf'])).size).toBe(0);
  });

  it('gives an empty map and never throws when the private storage throws', async () => {
    const store = createRecentThumbs(async (): Promise<DirectoryLike> => {
      throw new Error('blocked');
    });
    expect((await store.load(['a.pdf'])).size).toBe(0);
    expect(await store.save('a.pdf', jpeg('A'), false)).toBe(false);
    await expect(store.prune(['a.pdf'])).resolves.toBeUndefined();
  });
});
