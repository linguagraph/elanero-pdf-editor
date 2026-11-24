import { describe, expect, it } from 'vitest';
import {
  appendStrokePoint,
  boundsOf,
  calloutLine,
  defaultCalloutBox,
  distinctVertices,
  polyVertices,
} from './pointGeometry';

// The expected leaders are the engine's own (model/annotations.py callout_line), run for the same
// tips and box, so the preview and the placed callout draw the same line.
describe('calloutLine', () => {
  const box = { x0: 100, y0: 100, x1: 200, y1: 140 };
  const cases: [string, { x: number; y: number }, { x: number; y: number }[]][] = [
    [
      'left of the box, with a knee',
      { x: 10, y: 10 },
      [
        { x: 10, y: 10 },
        { x: 82, y: 120 },
        { x: 100, y: 120 },
      ],
    ],
    [
      'right of the box, with a knee',
      { x: 300, y: 120 },
      [
        { x: 300, y: 120 },
        { x: 218, y: 120 },
        { x: 200, y: 120 },
      ],
    ],
    [
      'above the box',
      { x: 150, y: 50 },
      [
        { x: 150, y: 50 },
        { x: 150, y: 100 },
      ],
    ],
    [
      'below the box',
      { x: 150, y: 200 },
      [
        { x: 150, y: 200 },
        { x: 150, y: 140 },
      ],
    ],
    [
      'inside the box',
      { x: 150, y: 120 },
      [
        { x: 150, y: 120 },
        { x: 100, y: 120 },
      ],
    ],
    [
      'just left, no room for a knee',
      { x: 95, y: 120 },
      [
        { x: 95, y: 120 },
        { x: 100, y: 120 },
      ],
    ],
    [
      'far left, with a knee',
      { x: 5, y: 120 },
      [
        { x: 5, y: 120 },
        { x: 82, y: 120 },
        { x: 100, y: 120 },
      ],
    ],
    [
      'left, too near for a knee',
      { x: 90, y: 120 },
      [
        { x: 90, y: 120 },
        { x: 100, y: 120 },
      ],
    ],
  ];
  for (const [name, tip, expected] of cases) {
    it(`matches the engine for a tip ${name}`, () => {
      expect(calloutLine(tip, box)).toEqual(expected);
    });
  }
});

describe('defaultCalloutBox', () => {
  it('is 180 by 40 at the click, on the side away from the tip', () => {
    expect(defaultCalloutBox({ x: 50, y: 50 }, { x: 200, y: 200 })).toEqual({
      x0: 200,
      y0: 180,
      x1: 380,
      y1: 220,
    });
    expect(defaultCalloutBox({ x: 50, y: 50 }, { x: 20, y: 200 })).toEqual({
      x0: -160,
      y0: 180,
      x1: 20,
      y1: 220,
    });
  });
});

describe('vertex rules', () => {
  it('drops a vertex within one point (Manhattan) of the one before', () => {
    expect(
      distinctVertices([
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 3, y: 0 },
      ]),
    ).toEqual([
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(
      distinctVertices([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toHaveLength(1);
    expect(
      distinctVertices([
        { x: 0, y: 0 },
        { x: 1, y: 0.01 },
      ]),
    ).toHaveLength(2);
  });

  it('needs three distinct corners for a polygon and two for a polyline', () => {
    const two = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(polyVertices('polygon', two)).toBeNull();
    expect(polyVertices('polyline', two)).toEqual(two);
    const three = [...two, { x: 10, y: 10 }];
    expect(polyVertices('polygon', three)).toEqual(three);
  });

  it('bounds a set of points', () => {
    expect(
      boundsOf([
        { x: 5, y: 9 },
        { x: 1, y: 2 },
        { x: 7, y: 4 },
      ]),
    ).toEqual({
      x0: 1,
      y0: 2,
      x1: 7,
      y1: 9,
    });
  });
});

describe('appendStrokePoint', () => {
  it('samples a point only once the pointer has moved half a point', () => {
    const first = appendStrokePoint([], { x: 0, y: 0 });
    expect(first).toEqual([{ x: 0, y: 0 }]);
    const same = appendStrokePoint(first, { x: 0.2, y: 0 });
    expect(same).toBe(first);
    expect(appendStrokePoint(first, { x: 1, y: 0 })).toHaveLength(2);
  });
});
