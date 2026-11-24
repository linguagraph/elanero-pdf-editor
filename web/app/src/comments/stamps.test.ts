// The stamp state after a custom stamp is removed (W7.3b S2): the fallback to Approved and the
// stamp tool turning off, which the stamp menu's caller applies.
import { describe, expect, it } from 'vitest';
import { afterStampRemoved, DEFAULT_STAMP, type ChosenStamp } from './stamps';

const custom: ChosenStamp = { kind: 'custom', id: 'abc', label: 'Logo' };

describe('afterStampRemoved', () => {
  it('falls back to Approved and turns the stamp tool off when the chosen stamp is removed', () => {
    const next = afterStampRemoved(custom, 'stamp', 'abc');
    expect(next.stamp).toEqual(DEFAULT_STAMP);
    expect(next.stamp).toEqual({ kind: 'standard', name: 'Approved' });
    expect(next.tool).toBeNull();
  });

  it('keeps another tool on when the chosen stamp is removed while a rectangle is active', () => {
    const next = afterStampRemoved(custom, 'rectangle', 'abc');
    expect(next.stamp).toEqual(DEFAULT_STAMP);
    expect(next.tool).toBe('rectangle');
  });

  it('changes nothing when a stamp other than the chosen one is removed', () => {
    const next = afterStampRemoved(custom, 'stamp', 'other');
    expect(next.stamp).toBe(custom);
    expect(next.tool).toBe('stamp');
  });

  it('changes nothing when a standard stamp is chosen', () => {
    const chosen: ChosenStamp = { kind: 'standard', name: 'Draft' };
    const next = afterStampRemoved(chosen, 'stamp', 'abc');
    expect(next.stamp).toBe(chosen);
    expect(next.tool).toBe('stamp');
  });
});
