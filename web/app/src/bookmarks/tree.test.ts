import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import { hasChildrenOf, initialExpanded, visibleRows } from './tree';

function entry(
  title: string,
  level: number,
  page: number | null = 0,
  is_open = false,
): OutlineEntry {
  return { title, level, page, is_open };
}

// Part A > Chapter A1 > Section A1a; Chapter A2; Part B (no children).
const outline: OutlineEntry[] = [
  entry('Part A', 1, 0, true),
  entry('Chapter A1', 2, 1),
  entry('Section A1a', 3, 2),
  entry('Chapter A2', 2, 3),
  entry('Part B', 1, 4),
];

describe('bookmarks tree', () => {
  it('finds the entries that have children from the levels', () => {
    expect(hasChildrenOf(outline)).toEqual([true, true, false, false, false]);
  });

  it('shows only the top level when nothing is expanded', () => {
    const rows = visibleRows(outline, new Set());
    expect(rows.map((row) => row.entry.title)).toEqual(['Part A', 'Part B']);
    expect(rows[0]?.expanded).toBe(false);
  });

  it('shows a nested entry only when every ancestor is expanded', () => {
    const onlyFirst = visibleRows(outline, new Set([0]));
    expect(onlyFirst.map((row) => row.entry.title)).toEqual([
      'Part A',
      'Chapter A1',
      'Chapter A2',
      'Part B',
    ]);
    const all = visibleRows(outline, new Set([0, 1]));
    expect(all.map((row) => row.entry.title)).toEqual([
      'Part A',
      'Chapter A1',
      'Section A1a',
      'Chapter A2',
      'Part B',
    ]);
  });

  it('keeps an inner expansion while its parent is collapsed', () => {
    const rows = visibleRows(outline, new Set([1]));
    expect(rows.map((row) => row.entry.title)).toEqual(['Part A', 'Part B']);
  });

  it('starts expanded where the file flags the entry as open', () => {
    expect([...initialExpanded(outline)]).toEqual([0]);
  });
});
