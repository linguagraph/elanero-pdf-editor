// The recent-files list (W1.1 section 6, W1.6 section 3, W4.2b). Only a file's name and the time it
// was opened are kept, in localStorage. No document bytes and no path: a browser never gives the
// page a path, and the bytes are not kept between visits. The storage rules are the preferences
// store's (src/prefs/store.ts): every access is wrapped in try/catch, and a key that looks like a
// secret is refused at the write boundary.
import { writeStoredValue } from '../prefs/store';

export const RECENT_STORAGE_KEY = 'elanero.recentFiles';
export const RECENT_LIMIT = 10;
export const RECENT_NAME_MAX_LENGTH = 255;

export interface RecentFile {
  readonly name: string;
  // Milliseconds since the epoch, as Date.now() gives.
  readonly openedAt: number;
}

// Keeps only the last path segment, drops control characters, and cuts the name to the limit. A
// name that is empty after that is not stored (null).
export function cleanRecentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  const printable = [...base]
    .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
    .join('')
    .trim();
  const name = printable.slice(0, RECENT_NAME_MAX_LENGTH);
  return name === '' ? null : name;
}

// Reads the list, newest first, capped at RECENT_LIMIT. Anything malformed is dropped entry by
// entry; a missing or throwing storage gives the empty list and never throws.
export function readRecentFiles(key: string = RECENT_STORAGE_KEY): RecentFile[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecentFile[] = [];
    for (const item of parsed as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { name, openedAt } = item as { name?: unknown; openedAt?: unknown };
      const cleaned = cleanRecentName(name);
      if (cleaned === null || typeof openedAt !== 'number' || !Number.isFinite(openedAt)) continue;
      entries.push({ name: cleaned, openedAt });
    }
    return entries.sort((a, b) => b.openedAt - a.openedAt).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

// Writes the list. Returns false when the key is refused or the browser would not keep it; a
// false return never throws.
export function writeRecentFiles(
  list: readonly RecentFile[],
  key: string = RECENT_STORAGE_KEY,
): boolean {
  return writeStoredValue(key, JSON.stringify(list));
}

// Records an opened file as the newest entry. A file with the same name replaces its older entry,
// so the list never shows one name twice. Returns the list as it now stands, even when the write
// fails, so the page can still show it for this visit.
export function addRecentFile(
  name: string,
  now: number = Date.now(),
  key: string = RECENT_STORAGE_KEY,
): RecentFile[] {
  const cleaned = cleanRecentName(name);
  const current = readRecentFiles(key);
  if (cleaned === null) return current;
  const next = [
    { name: cleaned, openedAt: now },
    ...current.filter((entry) => entry.name !== cleaned),
  ].slice(0, RECENT_LIMIT);
  writeRecentFiles(next, key);
  return next;
}
