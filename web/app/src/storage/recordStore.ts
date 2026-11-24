// The record-and-bytes store the browser's private storage uses for kept files (W6.9 slice 3, W7.3b
// design section 3.1). One bytes file and one JSON record per item, both named by the item's id (the
// sha256 of the bytes), so two tabs keeping different items never write the same file. The record is
// written last: an item with no record, or whose bytes differ in size from the record, is not listed.
// This module never talks to the engine. Like the autosave store, every call is wrapped: a failure is
// a result, never a throw.
import { fitsQuota, isQuotaError, removeIfPresent, writeFile } from './autosaveStore';
import {
  type BlobLike,
  type DirectoryLike,
  privateRoot,
  StorageUnsupportedError,
  storageEstimate,
} from './opfs';

const FORMAT = 1;
// A bytes file with no record this old is a write that was cut off. A younger one may be another
// tab's write in progress, so it is left alone.
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

// The fields every stored record has. A store adds its own fields through `hasFields`.
export interface StoredRecord {
  readonly id: string;
  readonly size: number;
  // ISO time the item was kept. The list is ordered by this, then by id.
  readonly added: string;
}

// "kept" when both files are in place; "no-space" when the estimate says it would not fit (or the
// disk refused it); "unsupported" when the browser lacks the storage API; "failed" for anything else.
export type KeepOutcome = 'kept' | 'no-space' | 'unsupported' | 'failed';

export interface RecordStore<R extends StoredRecord> {
  // False when the browser has no private storage, or the folder cannot be listed.
  available(): Promise<boolean>;
  // The kept records, complete ones only, in list order. Also removes old orphan bytes files.
  list(): Promise<R[]>;
  read(id: string): Promise<BlobLike | undefined>;
  write(record: R, data: Blob): Promise<KeepOutcome>;
  // True when the item is gone from the disk (already gone counts). Removes the folder when empty.
  remove(id: string): Promise<boolean>;
  // Deletes the whole folder, including any orphan. True when it is gone.
  removeAll(): Promise<boolean>;
}

// What a store is about: its folder, its bytes file extension, its id shape and its own fields.
export interface RecordSpec {
  readonly folder: string;
  readonly bytesExt: string;
  readonly idPattern: RegExp;
  // Checks the fields a store adds on top of the common ones (id, size, added).
  readonly hasFields: (value: Record<string, unknown>) => boolean;
}

export type PrivateRoot = () => Promise<DirectoryLike>;

function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'NotFoundError';
}

// A folder whose entries cannot be listed cannot hold items: the store could not find them again.
function canList(directory: DirectoryLike): boolean {
  return typeof directory.keys === 'function';
}

async function namesIn(folder: DirectoryLike): Promise<string[]> {
  const names: string[] = [];
  const keys = folder.keys;
  if (typeof keys !== 'function') return names;
  for await (const name of keys.call(folder)) names.push(name);
  return names;
}

// True when the folder has no entries left.
async function isEmpty(folder: DirectoryLike): Promise<boolean> {
  return (await namesIn(folder)).length === 0;
}

// The folder, or undefined when nothing was ever kept (no folder yet).
async function existingFolder(
  root: DirectoryLike,
  name: string,
): Promise<DirectoryLike | undefined> {
  try {
    return await root.getDirectoryHandle(name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export function createRecordStore<R extends StoredRecord>(
  spec: RecordSpec,
  root: PrivateRoot = privateRoot,
  estimate: typeof storageEstimate = storageEstimate,
): RecordStore<R> {
  const bytesName = (id: string): string => `${id}.${spec.bytesExt}`;
  const recordName = (id: string): string => `${id}.json`;

  function isRecord(value: unknown): value is R {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
      v['format'] === FORMAT &&
      typeof v['id'] === 'string' &&
      spec.idPattern.test(v['id']) &&
      typeof v['size'] === 'number' &&
      typeof v['added'] === 'string' &&
      spec.hasFields(v)
    );
  }

  // Reads one record and checks its bytes file is whole. Undefined when either is missing or wrong.
  async function readRecord(folder: DirectoryLike, id: string): Promise<R | undefined> {
    try {
      const text = await (await (await folder.getFileHandle(recordName(id))).getFile()).text();
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || parsed.id !== id) return undefined;
      const bytes = await (await folder.getFileHandle(bytesName(id))).getFile();
      return bytes.size === parsed.size ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  // Deletes a bytes file that has no record, but only once it is old enough to be a dead write.
  async function removeOrphan(folder: DirectoryLike, name: string): Promise<void> {
    try {
      const file = await (await folder.getFileHandle(name)).getFile();
      if (file.lastModified === undefined || Date.now() - file.lastModified < ORPHAN_AGE_MS) return;
      await folder.removeEntry(name);
    } catch {
      // Already gone, or unreadable: the next list tries again.
    }
  }

  return {
    async available() {
      try {
        const base = await root();
        if (!canList(base)) return false;
        const folder = await existingFolder(base, spec.folder);
        return folder === undefined || canList(folder);
      } catch {
        return false;
      }
    },

    async list() {
      try {
        const base = await root();
        if (!canList(base)) return [];
        const folder = await existingFolder(base, spec.folder);
        if (folder === undefined) return [];
        const names = await namesIn(folder);
        const records: R[] = [];
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const id = name.slice(0, -'.json'.length);
          if (!spec.idPattern.test(id)) continue;
          const record = await readRecord(folder, id);
          if (record !== undefined) records.push(record);
        }
        const listed = new Set(records.map((record) => bytesName(record.id)));
        for (const name of names) {
          if (name.endsWith(`.${spec.bytesExt}`) && !listed.has(name)) {
            await removeOrphan(folder, name);
          }
        }
        return records.sort((a, b) =>
          a.added === b.added ? a.id.localeCompare(b.id) : a.added.localeCompare(b.added),
        );
      } catch {
        return [];
      }
    },

    async read(id) {
      if (!spec.idPattern.test(id)) return undefined;
      try {
        const folder = await existingFolder(await root(), spec.folder);
        if (folder === undefined) return undefined;
        return await (await folder.getFileHandle(bytesName(id))).getFile();
      } catch {
        return undefined;
      }
    },

    async write(record, data) {
      try {
        const base = await root();
        // An item written here could never be listed back: refuse before writing a byte.
        if (!canList(base)) return 'unsupported';
        if (!fitsQuota(data.size, await estimate())) return 'no-space';
        const folder = await base.getDirectoryHandle(spec.folder, { create: true });
        // The bytes first, the record last: the record is what marks the item as kept.
        await writeFile(folder, bytesName(record.id), data);
        const json = JSON.stringify({ format: FORMAT, ...record });
        await writeFile(
          folder,
          recordName(record.id),
          new Blob([json], { type: 'application/json' }),
        );
        return 'kept';
      } catch (error) {
        if (error instanceof StorageUnsupportedError) return 'unsupported';
        return isQuotaError(error) ? 'no-space' : 'failed';
      }
    },

    async remove(id) {
      if (!spec.idPattern.test(id)) return false;
      try {
        const base = await root();
        const folder = await existingFolder(base, spec.folder);
        if (folder === undefined) return true;
        // The record goes first: without it the bytes are an orphan, which list removes later.
        await removeIfPresent(folder, recordName(id));
        await removeIfPresent(folder, bytesName(id));
        // Non-recursive and only when empty: an item another tab just wrote keeps the folder.
        if (await isEmpty(folder)) await base.removeEntry(spec.folder);
        return true;
      } catch {
        return false;
      }
    },

    async removeAll() {
      try {
        await (await root()).removeEntry(spec.folder, { recursive: true });
        return true;
      } catch (error) {
        return isNotFound(error);
      }
    },
  };
}
