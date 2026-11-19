// The palette's recent commands (W4.3b S2, decision D2): the commands run from the palette, newest
// first, so the list can sit at the top of an empty palette. Only palette runs are recorded; a
// ribbon click or a shortcut is not, as in VS Code, or the list fills with Undo and Save.
//
// The value is a JSON array of command ids. It holds no document names, is not a secret, and is
// not cleared with a document. Every access is guarded: a throwing or full storage gives an empty
// list and a dropped write, never an exception.
import { writeStoredValue } from '../prefs/store';

export const RECENT_COMMANDS_KEY = 'elanero.recentCommands';
export const RECENT_COMMANDS_LIMIT = 8;

// Longer than any command id, so a bad value cannot fill the list with junk.
const MAX_ID_LENGTH = 64;

// The stored ids, newest first. Anything that is not a short string, and any repeat, is dropped.
// Ids the registry does not know are kept: the palette ignores them, and a newer build may use
// them.
export function readRecentCommands(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_COMMANDS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string' || item.length > MAX_ID_LENGTH || seen.has(item)) continue;
      seen.add(item);
      ids.push(item);
      if (ids.length === RECENT_COMMANDS_LIMIT) break;
    }
    return ids;
  } catch {
    // Corrupt JSON or a throwing localStorage: the palette shows no recent commands.
    return [];
  }
}

// Moves the command to the front of the list, cutting the list to the limit. A write that the
// browser refuses is dropped silently (writeStoredValue reports it, and nothing else depends on it).
export function recordRecentCommand(id: string): void {
  if (id === '' || id.length > MAX_ID_LENGTH) return;
  const rest = readRecentCommands().filter((existing) => existing !== id);
  const next = [id, ...rest].slice(0, RECENT_COMMANDS_LIMIT);
  writeStoredValue(RECENT_COMMANDS_KEY, JSON.stringify(next));
}
