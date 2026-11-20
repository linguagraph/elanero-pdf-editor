// How many ribbon groups stay in a tab's row before the rest move to the "More commands" menu
// (W1.6 section 2, W4.3a S3). Pure, so the rules are tested without a browser. The row holds whole
// groups only, taken from the left, so the order of the row and the menu is the tab's order.

// `widths` holds each visible group's outer width including the gap after it, in tab order.
// Returns how many groups, from the left, stay in the row; the rest go to the menu.
export function visibleGroupCount(
  widths: readonly number[],
  available: number,
  moreWidth: number,
): number {
  const total = widths.reduce((sum, width) => sum + width, 0);
  // Everything fits: no menu button is needed, so it does not take a slot.
  if (total <= available) return widths.length;
  // Otherwise keep the longest prefix that leaves room for the menu button. It may be empty.
  let used = moreWidth;
  let count = 0;
  for (const width of widths) {
    if (used + width > available) break;
    used += width;
    count += 1;
  }
  return count;
}
