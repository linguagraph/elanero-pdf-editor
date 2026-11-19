// Page labels, page jump and the navigation history (W5.3, W1.4 sections 1 and 9). Pure functions
// over zero-based page indexes, so the status bar, the thumbnails and the keyboard all use one rule.
// Labels are the document's own page labels (a page with no label shows its number). The engine
// returns them with session.pages, and the document view passes them on; until then, none.

// The most positions the history keeps per tab. The oldest are dropped first.
export const MAX_HISTORY = 100;

// The label shown for a page: the document's label when it has a non-empty one, else the number.
export function pageLabelFor(index: number, labels?: readonly string[]): string {
  const label = labels?.[index]?.trim();
  return label !== undefined && label !== '' ? label : String(index + 1);
}

// The zero-based page a jump input names, or null when it names none. A label is tried first (an
// exact match after trimming), then a one-based page number within the document.
export function parsePageInput(
  input: string,
  total: number,
  labels?: readonly string[],
): number | null {
  const text = input.trim();
  if (text === '') return null;
  if (labels !== undefined) {
    const index = labels.findIndex((label, position) => {
      return position < total && label.trim() === text;
    });
    if (index !== -1) return index;
  }
  if (!/^\d+$/.test(text)) return null;
  const page = Number(text);
  if (page < 1 || page > total) return null;
  return page - 1;
}

// The history of one tab: the pages it has been on, in order, and the one the view is on now.
// `cursor` is -1 when nothing is recorded yet.
export interface NavHistory {
  readonly pages: readonly number[];
  readonly cursor: number;
}

export const EMPTY_HISTORY: NavHistory = { pages: [], cursor: -1 };

// Records a jump from one page to another. A move of one page or less is not recorded (the reader
// is still reading the same place), and neither is a repeat of the entry already current. A new
// jump after going back drops the forward entries, as a browser's history does.
export function recordJump(history: NavHistory, from: number, to: number): NavHistory {
  if (Math.abs(to - from) <= 1) return history;
  const pages = history.pages.slice(0, history.cursor + 1);
  if (pages[pages.length - 1] !== from) pages.push(from);
  if (pages[pages.length - 1] !== to) pages.push(to);
  const kept = pages.slice(Math.max(0, pages.length - MAX_HISTORY));
  return { pages: kept, cursor: kept.length - 1 };
}

export function canGoBack(history: NavHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: NavHistory): boolean {
  return history.cursor + 1 < history.pages.length;
}

// Moves the cursor one entry back or forward. Returns the page to show, or null when there is no
// entry that way.
export function stepHistory(
  history: NavHistory,
  direction: -1 | 1,
): { history: NavHistory; page: number } | null {
  const cursor = history.cursor + direction;
  const page = history.pages[cursor];
  if (page === undefined || cursor < 0) return null;
  return { history: { pages: history.pages, cursor }, page };
}
