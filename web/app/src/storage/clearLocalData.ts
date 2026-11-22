// "Clear all local data" (W4.5 Preferences, Privacy). It removes what Elanero keeps in this browser
// and nothing else: this origin can hold other apps' data (GitHub Pages shares one origin for all of
// a user's project sites), so only the keys and folders below are touched.

import { FONTS_FOLDER } from './fontStore';
import { privateRoot, StorageUnsupportedError, type DirectoryLike } from './opfs';

// Every Elanero localStorage key starts with this prefix (elanero.theme, elanero.prefs, ...).
export const LOCAL_STORAGE_PREFIX = 'elanero.';

// The OPFS folders Clear all removes. autosave/ is deliberately not here: each open Elanero tab
// keeps its recovery copies there, and another tab's unsaved work must survive a clear. Clear all
// is offered only when no document is open in this tab, so its own copies are not at risk either.
// The fonts folder is the one the font store writes (W6.9 slice 3), so Clear all removes what it keeps.
export const LOCAL_DATA_FOLDERS = [FONTS_FOLDER, 'secrets'] as const;

export interface ClearOutcome {
  readonly keysRemoved: number;
  // False when a step threw (a folder that exists but cannot be removed, a refusing storage).
  // A folder or key that is already gone counts as removed.
  readonly complete: boolean;
}

export interface ClearLocalDataDeps {
  storage?: () => Storage;
  root?: () => Promise<DirectoryLike>;
}

// Never throws: each step has its own try/catch, so one failing step cannot stop the others.
export async function clearLocalData(deps: ClearLocalDataDeps = {}): Promise<ClearOutcome> {
  const keys = clearPrefixedKeys(deps.storage ?? (() => window.localStorage));
  const folders = await clearFolders(deps.root ?? privateRoot);
  return { keysRemoved: keys.removed, complete: keys.complete && folders };
}

// Walks from the last index down: removing key i does not move the keys below it, so no key is
// skipped.
function clearPrefixedKeys(storage: () => Storage): { removed: number; complete: boolean } {
  let removed = 0;
  try {
    const target = storage();
    for (let i = target.length - 1; i >= 0; i -= 1) {
      const key = target.key(i);
      if (key !== null && key.startsWith(LOCAL_STORAGE_PREFIX)) {
        target.removeItem(key);
        removed += 1;
      }
    }
    return { removed, complete: true };
  } catch {
    return { removed, complete: false };
  }
}

async function clearFolders(root: () => Promise<DirectoryLike>): Promise<boolean> {
  let directory: DirectoryLike;
  try {
    directory = await root();
  } catch (error) {
    // No private file storage at all: there is nothing in it to remove.
    return error instanceof StorageUnsupportedError;
  }
  let complete = true;
  for (const name of LOCAL_DATA_FOLDERS) {
    try {
      await directory.removeEntry(name, { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) complete = false;
    }
  }
  return complete;
}

function isNotFound(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'NotFoundError';
}

// The action the Preferences dialog runs; a named type keeps the dialog's props free of generics.
export type ClearAction = () => Promise<ClearOutcome>;
