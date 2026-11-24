// The user's custom image stamps in this tab (W7.3b design sections 3.2 to 3.5). It owns the checks
// Add runs, the limits, and the fallback to stamps kept for this tab only when the browser's private
// storage cannot keep them. It never talks to the engine: a stamp's bytes reach the engine only when
// it is placed.
import { t } from '../i18n/t';
import { requestPersistence } from '../storage/fontStore';
import type { BlobLike } from '../storage/opfs';
import { createStampStore, type StampStore, type StoredStampRecord } from '../storage/stampStore';
import { imageSize } from './imageSize';

const MIB = 1024 * 1024;
// Hand copies of the caps the engine uses: custom_stamps.MAX_IMAGE_BYTES (20 MiB, the desktop
// library) and webapi/limits.py MAX_IMAGE_PIXELS (25 MP, the watermark picture check).
export const MAX_STAMP_BYTES = 20 * MIB;
export const MAX_IMAGE_PIXELS = 25_000_000;
// The library's own limits, the font store's numbers (W7.3b question 3).
export const MAX_STAMPS = 64;
export const MAX_LIBRARY_BYTES = 256 * MIB;
const LABEL_MAX = 100;

// A stamp the tab lists. `kept` is false for a stamp held for this tab only.
export type LibraryStamp = StoredStampRecord & { readonly kept: boolean };

export type RefusalReason = 'tooLarge' | 'wrongType' | 'tooManyPixels' | 'libraryFull';
// The reasons a stamp is still added, but only for this tab.
export type HeldReason = 'unsupported' | 'noSpace' | 'failed';

export type AddOutcome =
  | { readonly kind: 'added'; readonly stamp: LibraryStamp }
  | { readonly kind: 'held'; readonly stamp: LibraryStamp; readonly reason: HeldReason }
  | { readonly kind: 'already'; readonly stamp: LibraryStamp }
  | { readonly kind: 'refused'; readonly reason: RefusalReason };

export interface StampLibraryDeps {
  readonly store?: StampStore;
  readonly persist?: () => Promise<unknown>;
  // The library limits, overridable so a test need not write 256 MiB.
  readonly limits?: { readonly maxStamps: number; readonly maxBytes: number };
}

export interface StampLibrary {
  list(): Promise<LibraryStamp[]>;
  // Runs the Add checks in order, then keeps the picture (or holds it for this tab).
  add(file: File): Promise<AddOutcome>;
  // The picture bytes, or undefined when the stamp is gone (removed in another tab, say).
  read(id: string): Promise<BlobLike | undefined>;
  // True when the stamp is gone from the library. The caller falls back if it was the current one.
  remove(id: string): Promise<boolean>;
  // 'session' once the browser keeps nothing: the stamps go when the tab closes.
  storage(): Promise<'persistent' | 'session'>;
}

interface Held {
  readonly stamp: LibraryStamp;
  readonly data: File;
}

// The sha256 of the picture, 64 lowercase hex characters: the stamp's id.
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The desktop's label: the file name without its extension, `_` as spaces, trimmed and shortened.
// It is shown as text only, so a stray character is harmless; "stamp" when nothing is left.
export function stampLabel(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '');
  const label = stem.replace(/_/g, ' ').trim().slice(0, LABEL_MAX).trim();
  return label === '' ? 'stamp' : label;
}

function byAdded(a: LibraryStamp, b: LibraryStamp): number {
  return a.added === b.added ? a.id.localeCompare(b.id) : a.added.localeCompare(b.added);
}

export function createStampLibrary(deps: StampLibraryDeps = {}): StampLibrary {
  const store = deps.store ?? createStampStore();
  const persist = deps.persist ?? requestPersistence;
  const maxStamps = deps.limits?.maxStamps ?? MAX_STAMPS;
  const maxBytes = deps.limits?.maxBytes ?? MAX_LIBRARY_BYTES;
  const held = new Map<string, Held>();
  let sessionMode = false;
  let persistAsked = false;

  async function all(): Promise<LibraryStamp[]> {
    const kept = (await store.list()).map((record) => ({ ...record, kept: true }));
    return [...kept, ...[...held.values()].map((entry) => entry.stamp)].sort(byAdded);
  }

  function holdFor(stamp: LibraryStamp, data: File, reason: HeldReason): AddOutcome {
    held.set(stamp.id, { stamp, data });
    return { kind: 'held', stamp, reason };
  }

  return {
    list: all,

    async add(file) {
      if (file.size > MAX_STAMP_BYTES) return { kind: 'refused', reason: 'tooLarge' };
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const size = imageSize(bytes);
      if (size === null) return { kind: 'refused', reason: 'wrongType' };
      if (size.width * size.height > MAX_IMAGE_PIXELS) {
        return { kind: 'refused', reason: 'tooManyPixels' };
      }
      const id = await sha256Hex(buffer);
      const current = await all();
      // A picture already in the library is one stamp: the caller chooses it, nothing is written.
      const existing = current.find((stamp) => stamp.id === id);
      if (existing !== undefined) return { kind: 'already', stamp: existing };
      const total = current.reduce((sum, stamp) => sum + stamp.size, 0);
      if (current.length >= maxStamps || total + file.size > maxBytes) {
        return { kind: 'refused', reason: 'libraryFull' };
      }
      // imageSize accepted the bytes, so they are a PNG (signature 0x89 first) or a JPEG.
      const stamp: LibraryStamp = {
        id,
        label: stampLabel(file.name),
        size: file.size,
        type: bytes[0] === 0x89 ? 'png' : 'jpeg',
        width: size.width,
        height: size.height,
        added: new Date().toISOString(),
        kept: false,
      };
      if (!sessionMode && !(await store.available())) sessionMode = true;
      if (sessionMode) return holdFor(stamp, file, 'unsupported');
      const outcome = await store.write(stamp, file);
      if (outcome === 'kept') {
        if (!persistAsked) {
          persistAsked = true;
          void persist();
        }
        return { kind: 'added', stamp: { ...stamp, kept: true } };
      }
      if (outcome === 'unsupported') {
        sessionMode = true;
        return holdFor(stamp, file, 'unsupported');
      }
      return holdFor(stamp, file, outcome === 'no-space' ? 'noSpace' : 'failed');
    },

    async read(id) {
      const entry = held.get(id);
      if (entry !== undefined) return entry.data;
      return store.read(id);
    },

    async remove(id) {
      if (held.delete(id)) return true;
      return store.remove(id);
    },

    async storage() {
      if (sessionMode || !(await store.available())) return 'session';
      return 'persistent';
    },
  };
}

// The message for a refused Add. A test checks each one against its key (en.ts stamp.custom.*).
export function refusalText(reason: RefusalReason): string {
  switch (reason) {
    case 'tooLarge':
      return t('stamp.custom.tooLarge', { mb: MAX_STAMP_BYTES / MIB });
    case 'wrongType':
      return t('stamp.custom.wrongType');
    case 'tooManyPixels':
      return t('stamp.custom.tooManyPixels');
    case 'libraryFull':
      return t('stamp.custom.libraryFull');
  }
}
