// Which layout regions show at a window width (W1.6 section 8). Pure, so the boundaries are tested
// without a browser. Every width test is "at least", so each breakpoint value belongs to the wider
// tier: 1280 px is wide, 1279 px is medium, 768 px is tablet, 767 px is phone.
import { BREAKPOINTS_PX } from '../theme/tokens';

export type LayoutTier = 'wide' | 'medium' | 'tablet' | 'phone';
export type RibbonMode = 'full' | 'compact' | 'collapsed';

export interface LayoutRegions {
  readonly tier: LayoutTier;
  readonly ribbon: RibbonMode;
  readonly leftRail: boolean;
  // A docked panel takes its own column; a drawer floats over the page area.
  readonly leftPanel: 'docked' | 'drawer';
  readonly rightPanel: 'docked' | 'overlay';
}

export function layoutTierForWidth(width: number): LayoutTier {
  if (width >= BREAKPOINTS_PX.wide) return 'wide';
  if (width >= BREAKPOINTS_PX.medium) return 'medium';
  if (width >= BREAKPOINTS_PX.tablet) return 'tablet';
  return 'phone';
}

// The left rail hides below 768 px (it lives behind the app menu there, which lists the panels).
// There is no right rail: every panel docks or floats on the left stack (issue 827).
const REGIONS: Record<LayoutTier, LayoutRegions> = {
  wide: {
    tier: 'wide',
    ribbon: 'full',
    leftRail: true,
    leftPanel: 'docked',
    rightPanel: 'docked',
  },
  medium: {
    tier: 'medium',
    ribbon: 'compact',
    leftRail: true,
    leftPanel: 'docked',
    rightPanel: 'overlay',
  },
  tablet: {
    tier: 'tablet',
    ribbon: 'collapsed',
    leftRail: true,
    leftPanel: 'drawer',
    rightPanel: 'overlay',
  },
  phone: {
    tier: 'phone',
    ribbon: 'collapsed',
    leftRail: false,
    leftPanel: 'drawer',
    rightPanel: 'overlay',
  },
};

export function layoutForWidth(width: number): LayoutRegions {
  return REGIONS[layoutTierForWidth(width)];
}
