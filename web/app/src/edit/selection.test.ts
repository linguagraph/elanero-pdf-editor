import { describe, expect, it } from 'vitest';
import type { Hittable } from './hitTest';
import { clickSelection, pruneSelection, rubberSelection } from './selection';

const objects: Hittable[] = [
  { key: 'big', bbox: { x0: 0, y0: 0, x1: 200, y1: 200 } },
  { key: 'image', bbox: { x0: 50, y0: 50, x1: 80, y1: 70 } },
  { key: 'spot', bbox: { x0: 120, y0: 120, x1: 120, y1: 120 } },
];

describe('clickSelection', () => {
  it('selects only the object under a plain click', () => {
    expect(clickSelection([], objects, { x: 60, y: 60 }, 0, false)).toEqual(['image']);
    expect(clickSelection(['big'], objects, { x: 60, y: 60 }, 0, false)).toEqual(['image']);
  });

  it('clears the selection on a plain click on empty ground', () => {
    expect(clickSelection(['image'], objects, { x: 300, y: 300 }, 0, false)).toEqual([]);
  });

  it('keeps the selection on a Ctrl+click on empty ground', () => {
    expect(clickSelection(['image'], objects, { x: 300, y: 300 }, 0, true)).toEqual(['image']);
  });

  it('toggles the object under a Ctrl+click', () => {
    const added = clickSelection(['big'], objects, { x: 60, y: 60 }, 0, true);
    expect(added).toEqual(['big', 'image']);
    expect(clickSelection(added, objects, { x: 60, y: 60 }, 0, true)).toEqual(['big']);
  });

  it('uses the tolerance to pick a near-miss', () => {
    expect(clickSelection([], objects, { x: 48.5, y: 60 }, 0, false)).toEqual(['big']);
    expect(clickSelection([], objects, { x: 48.5, y: 60 }, 2, false)).toEqual(['image']);
  });
});

describe('rubberSelection', () => {
  it('replaces the selection with the objects the band meets', () => {
    const band = { x0: 40, y0: 40, x1: 60, y1: 60 };
    expect(rubberSelection(['spot'], objects, band, false)).toEqual(['big', 'image']);
  });

  it('selects by intersection, not containment', () => {
    const band = { x0: 79, y0: 69, x1: 81, y1: 71 };
    expect(rubberSelection([], objects, band, false)).toEqual(['big', 'image']);
  });

  it('does not select an object that only touches the band edge', () => {
    const band = { x0: 80, y0: 0, x1: 90, y1: 10 };
    expect(rubberSelection([], objects, band, false)).toEqual(['big']);
  });

  it('adds to the selection with Ctrl without duplicating keys', () => {
    const band = { x0: 40, y0: 40, x1: 60, y1: 60 };
    expect(rubberSelection(['image'], objects, band, true)).toEqual(['image', 'big']);
  });
});

describe('pruneSelection', () => {
  it('drops keys the list no longer holds', () => {
    expect(pruneSelection(['big', 'gone', 'image'], objects)).toEqual(['big', 'image']);
  });
});
