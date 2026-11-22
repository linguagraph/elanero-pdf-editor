// The autosave copies in the browser's private storage (W3.9 S2, W1.1 section 6). One copy per open
// document, at autosave/<tab-id>/<doc-id>.pdf, with a <doc-id>.json beside it that says what the copy
// is. The .json is written last, so it marks a complete copy: a reader ignores a .pdf with no .json,
// and one whose size differs from the size the .json recorded (a write that was cut off).
// Every access is wrapped in try/catch: a failure is a result, never a throw, so the page works
// without autosave.
import { type DirectoryLike, privateRoot, StorageUnsupportedError, storageEstimate } from './opfs';

export const AUTOSAVE_FOLDER = 'autosave';
const FORMAT = 1;

export interface AutosaveMeta {
  readonly name: string;
  // ISO time of the copy.
  readonly time: string;
  readonly pages: number;
}

export interface AutosaveCopy {
  readonly bytes: ArrayBuffer;
  readonly meta: AutosaveMeta;
}

// "written" when both files are in place; "no-space" when the estimate says the copy would not fit
// (or the disk refused it); "unsupported" when the browser lacks the storage API, which no retry
// will fix; "failed" for any other error. None of them throws.
export type WriteOutcome = 'written' | 'no-space' | 'unsupported' | 'failed';

export interface AutosaveStore {
  // False when the browser has no private storage. Checked before anything else is attempted.
  available(): Promise<boolean>;
  write(
    tabId: string,
    docId: number,
    bytes: ArrayBuffer,
    meta: AutosaveMeta,
  ): Promise<WriteOutcome>;
  // The copy, or undefined when there is none, or the copy is incomplete or unreadable.
  read(tabId: string, docId: number): Promise<AutosaveCopy | undefined>;
  remove(tabId: string, docId: number): Promise<void>;
  // Deletes every copy of one page load.
  removeTab(tabId: string): Promise<void>;
}

// The copy must fit with room to spare: the browser's estimate is approximate, and a half-written
// copy is worse than none. Hence the factor of two.
export function fitsQuota(
  size: number,
  estimate: { quota?: number; usage?: number } | undefined,
): boolean {
  if (estimate?.quota === undefined || estimate.usage === undefined) return true;
  return estimate.quota - estimate.usage >= size * 2;
}

export function isQuotaError(error: unknown): boolean {
  // Checked by name: a browser's DOMException is not always an instance of Error.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'QuotaExceededError'
  );
}

function docNames(docId: number): { pdf: string; json: string } {
  return { pdf: `${docId}.pdf`, json: `${docId}.json` };
}

// Walks to the folder of one page load. With create false a missing folder is an error, so a read
// of an absent copy does not make folders.
async function tabFolder(
  root: DirectoryLike,
  tabId: string,
  create: boolean,
): Promise<DirectoryLike> {
  const autosave = await root.getDirectoryHandle(AUTOSAVE_FOLDER, { create });
  return autosave.getDirectoryHandle(tabId, { create });
}

export async function removeIfPresent(dir: DirectoryLike, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // Already gone: the goal is that the file is absent.
  }
}

export async function writeFile(dir: DirectoryLike, name: string, data: Blob): Promise<void> {
  // A writable stream commits on close(), so the old file stays whole until the new one is complete.
  const handle = await dir.getFileHandle(name, { create: true });
  // Older Safari has no createWritable: say so, rather than failing the same way every minute.
  if (typeof handle.createWritable !== 'function') {
    throw new StorageUnsupportedError('the browser cannot write to private storage');
  }
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

function isMeta(value: unknown): value is AutosaveMeta & { size: number } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['format'] === FORMAT &&
    typeof v['name'] === 'string' &&
    typeof v['time'] === 'string' &&
    typeof v['pages'] === 'number' &&
    typeof v['size'] === 'number'
  );
}

export function createAutosaveStore(
  root: () => Promise<DirectoryLike> = privateRoot,
  estimate: typeof storageEstimate = storageEstimate,
): AutosaveStore {
  async function rootOrUndefined(): Promise<DirectoryLike | undefined> {
    try {
      return await root();
    } catch {
      return undefined;
    }
  }

  return {
    async available() {
      return (await rootOrUndefined()) !== undefined;
    },

    async write(tabId, docId, bytes, meta) {
      try {
        const base = await root();
        if (!fitsQuota(bytes.byteLength, await estimate())) return 'no-space';
        const dir = await tabFolder(base, tabId, true);
        const names = docNames(docId);
        await writeFile(dir, names.pdf, new Blob([bytes], { type: 'application/pdf' }));
        const sidecar = JSON.stringify({ format: FORMAT, ...meta, size: bytes.byteLength });
        await writeFile(dir, names.json, new Blob([sidecar], { type: 'application/json' }));
        return 'written';
      } catch (error) {
        if (error instanceof StorageUnsupportedError) return 'unsupported';
        return isQuotaError(error) ? 'no-space' : 'failed';
      }
    },

    async read(tabId, docId) {
      try {
        const base = await rootOrUndefined();
        if (base === undefined) return undefined;
        const dir = await tabFolder(base, tabId, false);
        const names = docNames(docId);
        const sidecarFile = await dir.getFileHandle(names.json);
        const parsed: unknown = JSON.parse(await (await sidecarFile.getFile()).text());
        if (!isMeta(parsed)) return undefined;
        const pdf = await (await dir.getFileHandle(names.pdf)).getFile();
        if (pdf.size !== parsed.size) return undefined;
        const bytes = await pdf.arrayBuffer();
        return {
          bytes,
          meta: { name: parsed.name, time: parsed.time, pages: parsed.pages },
        };
      } catch {
        return undefined;
      }
    },

    async remove(tabId, docId) {
      try {
        const base = await rootOrUndefined();
        if (base === undefined) return;
        const dir = await tabFolder(base, tabId, false);
        const names = docNames(docId);
        // The .json goes first: without it the .pdf is ignored, so a cut-off delete is harmless.
        // Each file is tried on its own, so a missing one does not keep the other from going.
        await removeIfPresent(dir, names.json);
        await removeIfPresent(dir, names.pdf);
      } catch {
        // No folder for this page load: nothing to delete.
      }
    },

    async removeTab(tabId) {
      try {
        const base = await rootOrUndefined();
        if (base === undefined) return;
        const autosave = await base.getDirectoryHandle(AUTOSAVE_FOLDER, { create: false });
        await autosave.removeEntry(tabId, { recursive: true });
      } catch {
        // No folder for this page load: nothing to delete.
      }
    },
  };
}
