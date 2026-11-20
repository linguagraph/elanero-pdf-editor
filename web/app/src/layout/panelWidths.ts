// The width of each side panel, remembered per side (W1.6 section 4: "Panel widths are remembered
// per side in localStorage"). The value lives in the local preferences store, so it is read and
// written with the same try/catch rules: a missing, corrupt or refused value gives the defaults.
import { LAYOUT_PX } from '../theme/tokens';
import { readStoredValue, writeStoredValue } from '../prefs/store';
import type { Side } from './sidePanels';

export interface PanelWidths {
  readonly left: number;
  readonly right: number;
}

export const PANEL_WIDTHS_STORAGE_KEY = 'elanero.layout.panelWidths';

// A panel may take at most this share of the window, so the page area keeps room at 1024 px.
const MAX_SHARE_OF_WINDOW = 0.4;

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  left: LAYOUT_PX.leftPanelWidth,
  right: LAYOUT_PX.rightPanelWidth,
};

export function maxPanelWidth(windowWidth: number): number {
  return Math.max(LAYOUT_PX.minPanelWidth, Math.floor(windowWidth * MAX_SHARE_OF_WINDOW));
}

// Keeps a width between the minimum and 40 % of the window (never below the minimum itself).
export function clampPanelWidth(width: number, windowWidth: number): number {
  const rounded = Math.round(width);
  return Math.min(maxPanelWidth(windowWidth), Math.max(LAYOUT_PX.minPanelWidth, rounded));
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
