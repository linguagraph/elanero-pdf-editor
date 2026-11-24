import { describe, expect, it } from 'vitest';
import { createRecordStore, type RecordSpec, type StoredRecord } from './recordStore';
import type { DirectoryLike } from './opfs';
import { MemoryDir } from './testRoot';

const ID = 'c'.repeat(64);
const roomy = async () => ({ quota: 1e9, usage: 0 });

const SPEC: RecordSpec = {
  folder: 'items',
  bytesExt: 'bin',
  idPattern: /^[0-9a-f]{64}$/,
  hasFields: () => true,
};

// Wraps a folder so each finished write (a writable closed) and each removeEntry is logged, with
// the path it touched. The wrapped folder behaves exactly as before.
function logging(dir: DirectoryLike, log: string[], prefix = ''): DirectoryLike {
  return {
    async getDirectoryHandle(name, options) {
      return logging(await dir.getDirectoryHandle(name, options), log, `${prefix}${name}/`);
    },
    async getFileHandle(name, options) {
      const handle = await dir.getFileHandle(name, options);
      return {
        getFile: () => handle.getFile(),
        async createWritable() {
          const writable = await handle.createWritable();
          return {
            write: (data: Blob) => writable.write(data),
            async close() {
              await writable.close();
              log.push(`write ${prefix}${name}`);
            },
          };
        },
      };
    },
    async removeEntry(name, options) {
      await dir.removeEntry(name, options);
      log.push(`remove ${prefix}${name}`);
    },
    keys() {
      return dir.keys?.() ?? (async function* () {})();
    },
  };
}

describe('recordStore write and remove order', () => {
  it('writes the bytes first and the record last', async () => {
    const log: string[] = [];
    const root = logging(new MemoryDir(), log);
    const store = createRecordStore<StoredRecord>(SPEC, async () => root, roomy);
    const record: StoredRecord = { id: ID, size: 3, added: '2026-01-01T00:00:00.000Z' };

    expect(await store.write(record, new Blob(['abc']))).toBe('kept');
    expect(log).toEqual([`write items/${ID}.bin`, `write items/${ID}.json`]);
  });

  it('removes the record first, then the bytes, then the empty folder', async () => {
    const log: string[] = [];
    const root = logging(new MemoryDir(), log);
    const store = createRecordStore<StoredRecord>(SPEC, async () => root, roomy);
    await store.write({ id: ID, size: 3, added: '2026-01-01T00:00:00.000Z' }, new Blob(['abc']));
    log.length = 0;

    expect(await store.remove(ID)).toBe(true);
    expect(log).toEqual([`remove items/${ID}.json`, `remove items/${ID}.bin`, 'remove items']);
  });
});
