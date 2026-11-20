// The width of each side panel, remembered per side (W1.6 section 4: "Panel widths are remembered
// per side in localStorage"). The value lives in the local preferences store, so it is read and
// written with the same try/catch rules: a missing, corrupt or refused value gives the defaults.
import { LAYOUT_PX } from '../theme/tokens';
import { readStoredValue, writeStoredValue } from '../prefs/store';
import type { LayoutTier } from './breakpoints';
import type { Side } from './sidePanels';

export interface PanelWidths {
  readonly left: number;
  readonly right: number;
}

export const PANEL_WIDTHS_STORAGE_KEY = 'elanero.layout.panelWidths';

// On the wide tier a docked panel may take at most this share of the window, so the page area keeps
// room at 1024 px.
const MAX_SHARE_OF_WINDOW = 0.4;

// On the narrower tiers the panels are drawers that float over the page. They keep their default
// width and only shrink to leave both rails and a small margin, so a drawer never fills the window.
const DRAWER_MARGIN_PX = 16;

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  left: LAYOUT_PX.leftPanelWidth,
  right: LAYOUT_PX.rightPanelWidth,
};

// The widest a panel may be at this window width and tier. Never below the minimum, so the
// resizer's range always has room to move.
export function maxPanelWidth(windowWidth: number, tier: LayoutTier = 'wide'): number {
  const available =
    tier === 'wide'
      ? Math.floor(windowWidth * MAX_SHARE_OF_WINDOW)
      : windowWidth - 2 * LAYOUT_PX.railWidth - DRAWER_MARGIN_PX;
  return Math.max(LAYOUT_PX.minPanelWidth, available);
}

// Keeps a width between the minimum and the tier's maximum (never below the minimum itself).
export function clampPanelWidth(
  width: number,
  windowWidth: number,
  tier: LayoutTier = 'wide',
): number {
  const rounded = Math.round(width);
  return Math.min(maxPanelWidth(windowWidth, tier), Math.max(LAYOUT_PX.minPanelWidth, rounded));
}

function storedWidth(record: unknown, side: Side): number {
  if (typeof record !== 'object' || record === null) return DEFAULT_PANEL_WIDTHS[side];
  const value = (record as Record<string, unknown>)[side];
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_PANEL_WIDTHS[side];
}

// The remembered widths, or the defaults for a missing key, bad JSON or a storage that throws.
export function readPanelWidths(): PanelWidths {
  const raw = readStoredValue(PANEL_WIDTHS_STORAGE_KEY);
  if (raw === null) return DEFAULT_PANEL_WIDTHS;
  try {
    const parsed: unknown = JSON.parse(raw);
    return { left: storedWidth(parsed, 'left'), right: storedWidth(parsed, 'right') };
  } catch {
    return DEFAULT_PANEL_WIDTHS;
  }
}

// Saves one side's width and keeps the other side's remembered value. A refused write is ignored:
// the width still applies for this page view.
export function writePanelWidth(side: Side, width: number): void {
  const current = readPanelWidths();
  const next: PanelWidths = { ...current, [side]: Math.round(width) };
  writeStoredValue(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(next));
}
