// Where the selection's bar or bubble goes, beside the last line of the selection (W6.6 section 8).
// Pure placement helpers, shared by the toolbar and the translation bubble.
// Where a bar of about this height goes, beside a line rectangle: above it when there is room.
const GAP = 8;
const BAR_HEIGHT = 40;

// The last line of the selection on screen: the last highlight the model draws, else the browser's
// selection. Null when nothing is shown.
export function anchorRect(selection: Selection | null): DOMRect | null {
  const marks = document.querySelectorAll('.page-selection-mark');
  const mark = marks.item(marks.length - 1);
  if (mark !== null) return mark.getBoundingClientRect();
  if (selection === null || selection.rangeCount === 0) return null;
  const lines = selection.getRangeAt(0).getClientRects();
  return lines.item(lines.length - 1);
}

// The top-left corner for a box of the given width beside the rectangle, kept inside the window.
export function placeSpot(
  rect: DOMRect,
  width: number,
): { readonly top: number; readonly left: number; readonly above: boolean } {
  const above = rect.top > BAR_HEIGHT + GAP;
  return {
    top: above ? rect.top - GAP : rect.bottom + GAP,
    left: Math.max(GAP, Math.min(rect.left, window.innerWidth - width - GAP)),
    above,
  };
}
