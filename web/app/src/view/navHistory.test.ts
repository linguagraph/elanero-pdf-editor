import { describe, expect, it } from 'vitest';
import { recordTabJump, stepTabHistory } from './navHistory';

// The store is module state, so each test uses tab ids of its own.
describe('per-tab navigation history', () => {
  it('keeps one history for each tab', () => {
    recordTabJump(101, 0, 9);
    recordTabJump(102, 0, 20);
    expect(stepTabHistory(101, -1)).toBe(0);
    expect(stepTabHistory(101, 1)).toBe(9);
    expect(stepTabHistory(102, -1)).toBe(0);
  });

  it('does nothing when there is no entry in that direction', () => {
    recordTabJump(103, 0, 9);
    expect(stepTabHistory(103, 1)).toBeNull();
    expect(stepTabHistory(104, -1)).toBeNull();
  });
});
