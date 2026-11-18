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
  readonly rightRail: boolean;
  readonly rightPanel: 'docked' | 'overlay';
}

export function layoutTierForWidth(width: number): LayoutTier {
  if (width >= BREAKPOINTS_PX.wide) return 'wide';
  if (width >= BREAKPOINTS_PX.medium) return 'medium';
  if (width >= BREAKPOINTS_PX.tablet) return 'tablet';
  return 'phone';
}

// The left rail hides below 768 px (it lives behind the app menu there). The right rail stays at
// every width, because it is what opens the Properties overlay on narrow screens.
const REGIONS: Record<LayoutTier, LayoutRegions> = {
  wide: {
    tier: 'wide',
    ribbon: 'full',
    leftRail: true,
    leftPanel: 'docked',
    rightRail: true,
    rightPanel: 'docked',
  },
  medium: {
    tier: 'medium',
    ribbon: 'compact',
    leftRail: true,
    leftPanel: 'docked',
    rightRail: true,
    rightPanel: 'overlay',
  },
  tablet: {
    tier: 'tablet',
    ribbon: 'collapsed',
    leftRail: true,
    leftPanel: 'drawer',
    rightRail: true,
    rightPanel: 'overlay',
  },
  phone: {
    tier: 'phone',
    ribbon: 'collapsed',
    leftRail: false,
    leftPanel: 'drawer',
    rightRail: true,
    rightPanel: 'overlay',
  },
};

export function layoutForWidth(width: number): LayoutRegions {
  return REGIONS[layoutTierForWidth(width)];
}
