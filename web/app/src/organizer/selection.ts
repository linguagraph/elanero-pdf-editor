// The page selection of the page organizer (W6.1): click picks one page, Ctrl-click toggles one,
// Shift-click picks the range from the anchor. Pure, so the rules are tested without a DOM.

export interface PageSelection {
  // The selected page indexes (zero-based), sorted and without repeats.
  readonly picked: readonly number[];
  // The page the last plain or Ctrl click landed on; a Shift-click extends from it.
  readonly anchor: number | null;
}

export interface SelectModifiers {
  readonly ctrl: boolean;
  readonly shift: boolean;
}

export const NO_SELECTION: PageSelection = { picked: [], anchor: null };

export function selectPage(
  selection: PageSelection,
  index: number,
  modifiers: SelectModifiers,
): PageSelection {
  if (modifiers.shift && selection.anchor !== null) {
    const low = Math.min(selection.anchor, index);
    const high = Math.max(selection.anchor, index);
    const picked = Array.from({ length: high - low + 1 }, (_, offset) => low + offset);
    return { picked, anchor: selection.anchor };
  }
  if (modifiers.ctrl) {
    const has = selection.picked.includes(index);
    const picked = has
      ? selection.picked.filter((page) => page !== index)
      : [...selection.picked, index].sort((a, b) => a - b);
    return { picked, anchor: index };
  }
  return { picked: [index], anchor: index };
}

// The selection after the page count changed: pages past the new end are dropped.
export function clampSelection(selection: PageSelection, count: number): PageSelection {
  const picked = selection.picked.filter((page) => page < count);
  const anchor = selection.anchor !== null && selection.anchor < count ? selection.anchor : null;
  return { picked, anchor };
}

// The page a move places the selection before (the engine's pages.move "before"), or null when the
// selection is already at that end. The selected pages move as one block, so a selection with gaps
// comes out contiguous.
export function moveTarget(
  direction: 'up' | 'down',
  picked: readonly number[],
  count: number,
): number | null {
  if (picked.length === 0) return null;
  const first = picked[0] ?? 0;
  const last = picked[picked.length - 1] ?? 0;
  if (direction === 'up') return first === 0 ? null : first - 1;
  return last >= count - 1 ? null : Math.min(last + 2, count);
}

// Deleting is allowed for some pages, never for all of them: a document keeps one page.
export function canDelete(picked: readonly number[], count: number): boolean {
  return picked.length > 0 && picked.length < count;
}

// The selection the engine reports after a move (pages.move returns the new indexes).
export function movedPages(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'number') ? (value as number[]) : null;
}
