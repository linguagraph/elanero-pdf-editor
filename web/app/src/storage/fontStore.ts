// The uploaded fonts the user keeps in the browser's private storage (W6.9 slice 3, design section
// 3.1). The record-and-bytes core lives in recordStore.ts (shared with the stamp library, W7.3b);
// this module names the font folder, the font id and the font record's own fields.
import { createRecordStore, type PrivateRoot, type RecordStore } from './recordStore';
import { privateRoot, storageEstimate } from './opfs';

export { ORPHAN_AGE_MS } from './recordStore';
export type { KeepOutcome, PrivateRoot } from './recordStore';

export const FONTS_FOLDER = 'fonts';
// The id is the sha256 of the bytes, 64 lowercase hex characters: it is also a file name.
export const FONT_ID = /^[0-9a-f]{64}$/;

export interface StoredFontRecord {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  // "truetype", "opentype" or "collection", as the engine reported it.
  readonly fontFormat: string;
  // ISO time the font was kept. The list is ordered by this, then by id.
  readonly added: string;
}

export type FontStore = RecordStore<StoredFontRecord>;

export function createFontStore(
  root: PrivateRoot = privateRoot,
  estimate: typeof storageEstimate = storageEstimate,
): FontStore {
  return createRecordStore<StoredFontRecord>(
    {
      folder: FONTS_FOLDER,
      bytesExt: 'font',
      idPattern: FONT_ID,
      hasFields: (v) => typeof v['name'] === 'string' && typeof v['fontFormat'] === 'string',
    },
    root,
    estimate,
  );
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
