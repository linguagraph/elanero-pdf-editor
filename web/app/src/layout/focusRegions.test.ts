import { describe, expect, it } from 'vitest';
import { nextRegion, REGION_ORDER, regionOf } from './focusRegions';

describe('F6 region order', () => {
  it('is ribbon, left, page, right, status, notifications', () => {
    expect(REGION_ORDER).toEqual(['ribbon', 'left', 'page', 'right', 'status', 'notifications']);
  });

  it('walks forward in the desktop order and wraps', () => {
    const all = [...REGION_ORDER];
    expect(nextRegion(all, 'ribbon', 1)).toBe('left');
    expect(nextRegion(all, 'page', 1)).toBe('right');
    expect(nextRegion(all, 'notifications', 1)).toBe('ribbon');
  });

  it('walks backward with Shift+F6 and wraps', () => {
    const all = [...REGION_ORDER];
    expect(nextRegion(all, 'right', -1)).toBe('page');
    expect(nextRegion(all, 'ribbon', -1)).toBe('notifications');
  });

  it('skips regions that are not present', () => {
    expect(nextRegion(['ribbon', 'page', 'notifications'], 'ribbon', 1)).toBe('page');
    expect(nextRegion(['ribbon', 'page'], 'page', 1)).toBe('ribbon');
    expect(nextRegion(['ribbon', 'page'], 'ribbon', -1)).toBe('page');
  });

  it('starts from the first region outside any region, and the last for Shift+F6', () => {
    expect(nextRegion([...REGION_ORDER], null, 1)).toBe('ribbon');
    expect(nextRegion([...REGION_ORDER], null, -1)).toBe('notifications');
  });

  it('keeps moving when the current region is no longer present', () => {
    // The left panel closed while the keyboard was in it.
    expect(nextRegion(['ribbon', 'page', 'right'], 'left', 1)).toBe('page');
    expect(nextRegion(['ribbon', 'page', 'right'], 'left', -1)).toBe('ribbon');
  });

  it('returns null when nothing can take the keyboard', () => {
    expect(nextRegion([], 'page', 1)).toBeNull();
  });

  it('maps a data-region attribute to a region name', () => {
    expect(regionOf('page')).toBe('page');
    expect(regionOf('unknown')).toBeNull();
    expect(regionOf(undefined)).toBeNull();
  });
});
