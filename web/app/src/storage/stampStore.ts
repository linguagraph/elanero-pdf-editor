// The custom image stamps the user keeps in the browser's private storage (W7.3b design section 3.1).
// The record-and-bytes core is shared with the font store (recordStore.ts). The id is the sha256 of
// the picture, so the same picture added twice is one stamp. This module never talks to the engine.
import { createRecordStore, type PrivateRoot, type RecordStore } from './recordStore';
import { privateRoot, storageEstimate } from './opfs';

export const STAMPS_FOLDER = 'stamps';
// The id is the sha256 of the picture, 64 lowercase hex characters: it is also a file name.
export const STAMP_ID = /^[0-9a-f]{64}$/;

export interface StoredStampRecord {
  readonly id: string;
  // The file name without its extension, `_` as spaces (desktop CustomStamp.label). Shown as text
  // only, never used as a path.
  readonly label: string;
  readonly size: number;
  readonly type: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
  // ISO time the stamp was kept. The list is ordered by this, then by id.
  readonly added: string;
}

export type StampStore = RecordStore<StoredStampRecord>;

const TYPES = new Set(['png', 'jpeg']);

export function createStampStore(
  root: PrivateRoot = privateRoot,
  estimate: typeof storageEstimate = storageEstimate,
): StampStore {
  return createRecordStore<StoredStampRecord>(
    {
      folder: STAMPS_FOLDER,
      bytesExt: 'img',
      idPattern: STAMP_ID,
      hasFields: (v) =>
        typeof v['label'] === 'string' &&
        typeof v['type'] === 'string' &&
        TYPES.has(v['type']) &&
        typeof v['width'] === 'number' &&
        typeof v['height'] === 'number',
    },
    root,
    estimate,
  );
}
