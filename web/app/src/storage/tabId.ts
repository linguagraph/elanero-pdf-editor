// The id of this browser tab's page load (W1.1 section 6). It names the folder the autosaves of this
// page go into, so a second tab never reads or deletes another tab's copies. It is made once per
// page load and held in memory only: a reload gets a new id, and the copies of the old one are then
// left for the cross-tab recovery (a later task).

let current: string | undefined;

function newId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  } catch {
    // Fall through: an id from Math.random is still unique enough for one folder name.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function browserTabId(): string {
  current ??= newId();
  return current;
}
