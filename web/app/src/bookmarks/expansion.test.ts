import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import { expandedOf, fingerprintOf, forgetBookmarksTab, setExpandedOf } from './expansion';

const entry = (title: string, level: number): OutlineEntry => ({
  title,
  level,
  page: 0,
  is_open: false,
  top: null,
});

describe('bookmark expansion keys', () => {
  it('names an outline by its levels and titles, not by its order alone', () => {
    const a = [entry('A', 1), entry('B', 2)];
    const swapped = [entry('B', 2), entry('A', 1)];
    expect(fingerprintOf(a)).toBe(fingerprintOf([entry('A', 1), entry('B', 2)]));
    expect(fingerprintOf(a)).not.toBe(fingerprintOf(swapped));
  });

  it('keeps the last eight outlines of a tab, so an Undo finds the earlier expansion', () => {
    const tab = 40;
    for (let k = 0; k < 9; k += 1) setExpandedOf(tab, `key${k}`, new Set([k]));
    expect(expandedOf(tab, 'key0')).toBeUndefined();
    expect(expandedOf(tab, 'key1')).toEqual(new Set([1]));
    expect(expandedOf(tab, 'key8')).toEqual(new Set([8]));
    forgetBookmarksTab(tab);
    expect(expandedOf(tab, 'key8')).toBeUndefined();
  });
});
