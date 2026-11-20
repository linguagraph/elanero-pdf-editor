// F6 and Shift+F6 move the keyboard between the layout regions in the desktop order (W1.6 section
// 12; desktop ui/focus_regions.py). This module is the pure part: which regions are present and
// where the next one is. The DOM work lives in useFocusRegions.ts.

export const REGION_ORDER = ['ribbon', 'left', 'page', 'right', 'status', 'notifications'] as const;

export type RegionName = (typeof REGION_ORDER)[number];

// The next region that can take the keyboard, from ``current`` in the order (wrapping). ``present``
// lists the regions with something to focus right now; an absent region (a hidden dock, an empty
// status bar) is skipped. From outside every region, F6 lands on the first and Shift+F6 on the
// last. When ``current`` is itself absent (for example its panel closed), the walk starts from its
// place in the order, so the keyboard still moves on.
export function nextRegion(
  present: readonly RegionName[],
  current: RegionName | null,
  step: 1 | -1,
): RegionName | null {
  const count = REGION_ORDER.length;
  const here = current === null ? -1 : REGION_ORDER.indexOf(current);
  // Start one step before the first region for F6 and one after the last for Shift+F6.
  const start = here !== -1 ? here : step === 1 ? -1 : count;
  for (let k = 1; k <= count; k += 1) {
    const index = (((start + step * k) % count) + count) % count;
    const name = REGION_ORDER[index];
    if (name !== undefined && present.includes(name)) return name;
  }
  return null;
}

// The region a keyboard step should land in, given the data-region attribute of the element that
// holds focus (null when focus is outside every region).
export function regionOf(attribute: string | null | undefined): RegionName | null {
  return REGION_ORDER.find((name) => name === attribute) ?? null;
}
