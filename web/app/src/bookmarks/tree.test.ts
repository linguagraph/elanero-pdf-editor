import { describe, expect, it } from 'vitest';
import type { OutlineEntry } from '../rpc/generated';
import { hasChildrenOf, initialExpanded, treeAction, visibleRows } from './tree';

function entry(
  title: string,
  level: number,
  page: number | null = 0,
  is_open = false,
): OutlineEntry {
  return { title, level, page, is_open, top: null };
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

describe('bookmarks keys', () => {
  // Rows with Part A and Chapter A1 open: Part A, Chapter A1, Section A1a, Chapter A2, Part B.
  const rows = visibleRows(outline, new Set([0, 1]));
  // Rows with only Part A open: Part A, Chapter A1, Chapter A2, Part B.
  const closedChapter = visibleRows(outline, new Set([0]));

  it('moves up and down through the visible rows, and stops at the ends', () => {
    expect(treeAction(rows, 'ArrowDown', 0)).toEqual({ kind: 'focus', index: 1 });
    expect(treeAction(rows, 'ArrowUp', 1)).toEqual({ kind: 'focus', index: 0 });
    expect(treeAction(rows, 'ArrowUp', 0)).toEqual({ kind: 'none' });
    expect(treeAction(rows, 'ArrowDown', 4)).toEqual({ kind: 'none' });
  });

  it('skips the hidden rows when moving down', () => {
    expect(treeAction(closedChapter, 'ArrowDown', 1)).toEqual({ kind: 'focus', index: 3 });
  });

  it('goes to the first and last visible row with Home and End', () => {
    expect(treeAction(rows, 'Home', 2)).toEqual({ kind: 'focus', index: 0 });
    expect(treeAction(rows, 'End', 0)).toEqual({ kind: 'focus', index: 4 });
  });

  it('expands a closed entry on Right, and steps into an open one', () => {
    expect(treeAction(closedChapter, 'ArrowRight', 0)).toEqual({ kind: 'focus', index: 1 });
    expect(treeAction(visibleRows(outline, new Set()), 'ArrowRight', 0)).toEqual({
      kind: 'expand',
      index: 0,
    });
    expect(treeAction(rows, 'ArrowRight', 2)).toEqual({ kind: 'none' });
  });

  it('collapses an open entry on Left, and goes to the parent otherwise', () => {
    expect(treeAction(rows, 'ArrowLeft', 0)).toEqual({ kind: 'collapse', index: 0 });
    expect(treeAction(rows, 'ArrowLeft', 2)).toEqual({ kind: 'focus', index: 1 });
    expect(treeAction(rows, 'ArrowLeft', 4)).toEqual({ kind: 'none' });
  });

  it('chooses the entry on Enter and Space', () => {
    expect(treeAction(rows, 'Enter', 2)).toEqual({ kind: 'activate', index: 2 });
    expect(treeAction(rows, ' ', 2)).toEqual({ kind: 'activate', index: 2 });
    expect(treeAction(rows, 'a', 2)).toEqual({ kind: 'none' });
  });

  it('adds after the row on Alt+Shift+N, matched by the physical key', () => {
    const add = { alt: true, shift: true, code: 'KeyN' };
    expect(treeAction(rows, 'N', 2, add)).toEqual({ kind: 'add', index: 2 });
    // On a Mac, Option+Shift+N types a different character, so the key name is not used.
    expect(treeAction(rows, '˜', 2, add)).toEqual({ kind: 'add', index: 2 });
    expect(treeAction(rows, 'N', 2, { ...add, ctrl: true })).toEqual({ kind: 'none' });
    expect(treeAction(rows, 'N', 2, { alt: true, code: 'KeyN' })).toEqual({ kind: 'none' });
    expect(treeAction(rows, 'n', 2, { code: 'KeyN' })).toEqual({ kind: 'none' });
  });
});
