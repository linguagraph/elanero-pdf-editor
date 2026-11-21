// The bookmarks panel's expanded entries per tab (W5.2). Kept in memory only, like the open panel:
// a reload starts with the file's own flags. The panel's open state is the side-panel store's.
//
// An outline is named by a fingerprint of its levels and titles, not its entry count: after a move
// the count is the same but the indices have changed. Each tab keeps the last few outlines, so an
// Undo (which reloads the older outline) finds the expansion it had.
import type { OutlineEntry } from '../rpc/generated';

const KEEP = 8;

const expandedByTab = new Map<number, { key: string; expanded: Set<number> }[]>();

// A 32-bit FNV-1a hash of each entry's level and title, with the count.
export function fingerprintOf(entries: readonly OutlineEntry[]): string {
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    const text = `${entry.level}:${entry.title}\n`;
    for (let k = 0; k < text.length; k += 1) {
      hash ^= text.charCodeAt(k);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `${entries.length}:${hash.toString(16)}`;
}

// The expanded entries saved for the tab's outline with this fingerprint, or undefined when there
// are none. An unknown outline falls back to the file's own flags.
export function expandedOf(tabId: number, key: string): Set<number> | undefined {
  return expandedByTab.get(tabId)?.find((saved) => saved.key === key)?.expanded;
}

export function setExpandedOf(tabId: number, key: string, expanded: Set<number>): void {
  const kept = (expandedByTab.get(tabId) ?? []).filter((saved) => saved.key !== key);
  kept.push({ key, expanded });
  expandedByTab.set(tabId, kept.slice(-KEEP));
}

// Drops the expansion kept for a tab that closed (called by the document tabs).
export function forgetBookmarksTab(tabId: number): void {
  expandedByTab.delete(tabId);
}
