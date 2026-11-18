import { describe, expect, it } from 'vitest';
import { BREAKPOINTS_PX } from '../theme/tokens';
import { layoutForWidth, layoutTierForWidth } from './breakpoints';

describe('layout breakpoints (W1.6 section 8)', () => {
  it.each([
    [1280, 'wide'],
    [1279, 'medium'],
    [1024, 'medium'],
    [1023, 'tablet'],
    [768, 'tablet'],
    [767, 'phone'],
    [0, 'phone'],
  ] as const)('width %i is the %s tier', (width, tier) => {
    expect(layoutTierForWidth(width)).toBe(tier);
  });

  it('takes its values from the tokens module', () => {
    expect(BREAKPOINTS_PX).toEqual({ wide: 1280, medium: 1024, tablet: 768 });
  });

  it('shows the full ribbon and docked panels from 1280 px', () => {
    expect(layoutForWidth(1280)).toMatchObject({
      ribbon: 'full',
      leftRail: true,
      leftPanel: 'docked',
      rightPanel: 'docked',
    });
  });

  it('compacts the ribbon and floats the inspector from 1024 to 1279 px', () => {
    expect(layoutForWidth(1100)).toMatchObject({
      ribbon: 'compact',
      leftPanel: 'docked',
      rightPanel: 'overlay',
    });
  });

  it('collapses the ribbon and makes the left panel a drawer from 768 to 1023 px', () => {
    expect(layoutForWidth(800)).toMatchObject({
      ribbon: 'collapsed',
      leftRail: true,
      leftPanel: 'drawer',
      rightPanel: 'overlay',
    });
  });

  it('hides the left rail below 768 px and keeps the right rail', () => {
    expect(layoutForWidth(390)).toMatchObject({
      tier: 'phone',
      leftRail: false,
      rightRail: true,
    });
  });
});
