// The uploaded fonts the user keeps in the browser's private storage (W6.9 slice 3, design section
// 3.1). One bytes file and one record per font, both named by the font's sha256, so two tabs keeping
// different fonts never write the same file. The record is written last: a font with no record, or
// whose bytes differ in size from the record, is not listed. This module never talks to the engine.
// Like the autosave store, every call is wrapped: a failure is a result, never a throw.
import { fitsQuota, isQuotaError, removeIfPresent, writeFile } from './autosaveStore';
import {
  type BlobLike,
  type DirectoryLike,
  privateRoot,
  StorageUnsupportedError,
  storageEstimate,
} from './opfs';

export const FONTS_FOLDER = 'fonts';
// The id is the sha256 of the bytes, 64 lowercase hex characters: it is also a file name.
export const FONT_ID = /^[0-9a-f]{64}$/;
const FORMAT = 1;
// A bytes file with no record this old is a write that was cut off. A younger one may be another
// tab's write in progress, so it is left alone.
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

export interface StoredFontRecord {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  // "truetype", "opentype" or "collection", as the engine reported it.
  readonly fontFormat: string;
  // ISO time the font was kept. The list is ordered by this, then by id.
  readonly added: string;
}

// "kept" when both files are in place; "no-space" when the estimate says it would not fit (or the
// disk refused it); "unsupported" when the browser lacks the storage API; "failed" for anything else.
export type KeepOutcome = 'kept' | 'no-space' | 'unsupported' | 'failed';

export interface FontStore {
  // False when the browser has no private storage, or the folder cannot be listed.
  available(): Promise<boolean>;
  // The kept fonts, complete ones only, in list order. Also removes old orphan bytes files.
  list(): Promise<StoredFontRecord[]>;
  read(id: string): Promise<BlobLike | undefined>;
  write(record: StoredFontRecord, data: Blob): Promise<KeepOutcome>;
  // True when the font is gone from the disk (already gone counts). Removes the folder when empty.
  remove(id: string): Promise<boolean>;
  // Deletes the whole folder, including any orphan. True when it is gone.
  removeAll(): Promise<boolean>;
}

export type PrivateRoot = () => Promise<DirectoryLike>;

function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'NotFoundError';
}

function bytesName(id: string): string {
  return `${id}.font`;
}

function recordName(id: string): string {
  return `${id}.json`;
}

function isRecord(value: unknown): value is StoredFontRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['format'] === FORMAT &&
    typeof v['id'] === 'string' &&
    FONT_ID.test(v['id']) &&
    typeof v['name'] === 'string' &&
    typeof v['size'] === 'number' &&
    typeof v['fontFormat'] === 'string' &&
    typeof v['added'] === 'string'
  );
}

// The folder, or undefined when no font was ever kept (no folder yet).
async function existingFolder(root: DirectoryLike): Promise<DirectoryLike | undefined> {
  try {
    return await root.getDirectoryHandle(FONTS_FOLDER);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

// A folder whose entries cannot be listed cannot hold fonts: the store could not find them again.
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

// Reads one record and checks its bytes file is whole. Undefined when either is missing or wrong.
async function readRecord(
  folder: DirectoryLike,
  id: string,
): Promise<StoredFontRecord | undefined> {
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

// True when the folder has no entries left.
async function isEmpty(folder: DirectoryLike): Promise<boolean> {
  return (await namesIn(folder)).length === 0;
}

export function createFontStore(
  root: PrivateRoot = privateRoot,
  estimate: typeof storageEstimate = storageEstimate,
): FontStore {
  return {
    async available() {
      try {
        const base = await root();
        if (!canList(base)) return false;
        const folder = await existingFolder(base);
        return folder === undefined || canList(folder);
      } catch {
        return false;
      }
    },

    async list() {
      try {
        const base = await root();
        if (!canList(base)) return [];
        const folder = await existingFolder(base);
        if (folder === undefined) return [];
        const names = await namesIn(folder);
        const records: StoredFontRecord[] = [];
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const id = name.slice(0, -'.json'.length);
          if (!FONT_ID.test(id)) continue;
          const record = await readRecord(folder, id);
          if (record !== undefined) records.push(record);
        }
        const listed = new Set(records.map((record) => bytesName(record.id)));
        for (const name of names) {
          if (name.endsWith('.font') && !listed.has(name)) await removeOrphan(folder, name);
        }
        return records.sort((a, b) =>
          a.added === b.added ? a.id.localeCompare(b.id) : a.added.localeCompare(b.added),
        );
      } catch {
        return [];
      }
    },

    async read(id) {
      if (!FONT_ID.test(id)) return undefined;
      try {
        const folder = await existingFolder(await root());
        if (folder === undefined) return undefined;
        return await (await folder.getFileHandle(bytesName(id))).getFile();
      } catch {
        return undefined;
      }
    },

    async write(record, data) {
      try {
        const base = await root();
        // A font written here could never be listed back: refuse before writing a byte.
        if (!canList(base)) return 'unsupported';
        if (!fitsQuota(data.size, await estimate())) return 'no-space';
        const folder = await base.getDirectoryHandle(FONTS_FOLDER, { create: true });
        // The bytes first, the record last: the record is what marks the font as kept.
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
      if (!FONT_ID.test(id)) return false;
      try {
        const base = await root();
        const folder = await existingFolder(base);
        if (folder === undefined) return true;
        // The record goes first: without it the bytes are an orphan, which list removes later.
        await removeIfPresent(folder, recordName(id));
        await removeIfPresent(folder, bytesName(id));
        // Non-recursive and only when empty: a font another tab just wrote keeps the folder.
        if (await isEmpty(folder)) await base.removeEntry(FONTS_FOLDER);
        return true;
      } catch {
        return false;
      }
    },

    async removeAll() {
      try {
        await (await root()).removeEntry(FONTS_FOLDER, { recursive: true });
        return true;
      } catch (error) {
        return isNotFound(error);
      }
    },
  };
}

// Asks the browser to keep this origin's storage (W1.1 section 6). The answer is not shown: the
// browser may grant it silently, or ask the user itself. Never throws.
export async function requestPersistence(): Promise<void> {
  try {
    const storage = (globalThis as { navigator?: { storage?: { persist?: unknown } } }).navigator
      ?.storage;
    if (typeof storage?.persist === 'function') {
      await (storage.persist as () => Promise<boolean>).call(storage);
    }
  } catch {
    // The request is best effort: without it the fonts are kept all the same.
  }
}
