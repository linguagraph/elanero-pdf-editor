import { describe, expect, it } from 'vitest';
import { layoutTierForWidth, type LayoutTier } from '../layout/breakpoints';
import { ribbonForm } from './form';

const NONE = { compact: false, collapsed: false };
const COMPACT = { compact: true, collapsed: false };
const COLLAPSED = { compact: false, collapsed: true };

describe('ribbonForm', () => {
  it.each<[LayoutTier, Parameters<typeof ribbonForm>[1], ReturnType<typeof ribbonForm>]>([
    ['phone', NONE, { kind: 'collapsed', collapsedBy: 'tier' }],
    ['phone', COLLAPSED, { kind: 'collapsed', collapsedBy: 'tier' }],
    ['tablet', COMPACT, { kind: 'collapsed', collapsedBy: 'tier' }],
    ['wide', COLLAPSED, { kind: 'collapsed', collapsedBy: 'user' }],
    ['medium', COLLAPSED, { kind: 'collapsed', collapsedBy: 'user' }],
    ['medium', NONE, { kind: 'compact', collapsedBy: null }],
    ['wide', COMPACT, { kind: 'compact', collapsedBy: null }],
    ['wide', NONE, { kind: 'full', collapsedBy: null }],
  ])('%s with %j gives %j', (tier, prefs, expected) => {
    expect(ribbonForm(tier, prefs)).toEqual(expected);
  });

  it('follows the breakpoints at 767, 768, 1023, 1024, 1279 and 1280 px', () => {
    const kindAt = (width: number) => ribbonForm(layoutTierForWidth(width), NONE).kind;
    expect([767, 768, 1023, 1024, 1279, 1280].map(kindAt)).toEqual([
      'collapsed',
      'collapsed',
      'collapsed',
      'compact',
      'compact',
      'full',
    ]);
  });
});
