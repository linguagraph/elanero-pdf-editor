import { describe, expect, it } from 'vitest';
import { computeColumn } from './layout';
import { stepZoom } from './zoom';
import {
  anchoredScroll,
  isZoomWheel,
  takeWheelSteps,
  WHEEL_STEP_PX,
  wheelDeltaPixels,
} from './wheel';

describe('Ctrl and Cmd select the zoom wheel', () => {
  it('takes Ctrl (Windows, Linux) and Meta (macOS), not a plain wheel', () => {
    expect(isZoomWheel({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isZoomWheel({ ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('wheel deltas', () => {
  it('converts lines and pages to pixels', () => {
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: 0 })).toBe(3);
    expect(wheelDeltaPixels({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelDeltaPixels({ deltaY: -1, deltaMode: 2 })).toBe(-800);
  });

  it('zooms in for a wheel up and out for a wheel down, one step per threshold', () => {
    expect(takeWheelSteps(0, -WHEEL_STEP_PX)).toEqual({ direction: 1, pending: 0 });
    expect(takeWheelSteps(0, WHEEL_STEP_PX)).toEqual({ direction: -1, pending: 0 });
  });

  it('adds small deltas up until a step is reached', () => {
    const first = takeWheelSteps(0, -15);
    expect(first).toEqual({ direction: null, pending: -15 });
    expect(takeWheelSteps(first.pending, -30)).toEqual({ direction: 1, pending: 0 });
  });
});

describe('anchored zoom keeps the pointed-at point in place', () => {
  it('keeps the same document point under the pointer when zooming in', () => {
    // A page at zoom 1 and at zoom 2: every content coordinate scales with the zoom.
    const sizes = [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ];
    const pointer = { x: 200, y: 150 };
    const before = { left: 30, top: 900 };
    const next = anchoredScroll({
      scrollLeft: before.left,
      scrollTop: before.top,
      pointerX: pointer.x,
      pointerY: pointer.y,
      fromZoom: 1,
      toZoom: 2,
    });
    // The page top of the second page is a content point; after the zoom it is at the same
    // distance from the pointer, scaled by the zoom ratio.
    const oldTop = computeColumn(sizes, 1).boxes[1]?.top ?? 0;
    const newTop = computeColumn(sizes, 2).boxes[1]?.top ?? 0;
    const oldLeft = computeColumn(sizes, 1).boxes[1]?.left ?? 0;
    const newLayoutLeft = computeColumn(sizes, 2).boxes[1]?.left ?? 0;
    expect(newTop / oldTop).toBeCloseTo(2, 6);
    expect(newLayoutLeft / oldLeft).toBeCloseTo(2, 6);
    // The content point under the pointer (old content coordinates) is now at twice its position.
    expect(next.top + pointer.y).toBeCloseTo((before.top + pointer.y) * 2, 6);
    expect(next.left + pointer.x).toBeCloseTo((before.left + pointer.x) * 2, 6);
  });

  it('keeps the point when zooming out', () => {
    const next = anchoredScroll({
      scrollLeft: 400,
      scrollTop: 1200,
      pointerX: 100,
      pointerY: 300,
      fromZoom: 2,
      toZoom: 1,
    });
    expect(next.left + 100).toBeCloseTo((400 + 100) / 2);
    expect(next.top + 300).toBeCloseTo((1200 + 300) / 2);
  });

  it('is the identity for the same zoom', () => {
    expect(
      anchoredScroll({
        scrollLeft: 12,
        scrollTop: 34,
        pointerX: 5,
        pointerY: 6,
        fromZoom: 1.5,
        toZoom: 1.5,
      }),
    ).toEqual({ left: 12, top: 34 });
  });

  it('never returns a negative scroll position', () => {
    expect(
      anchoredScroll({
        scrollLeft: 0,
        scrollTop: 0,
        pointerX: 300,
        pointerY: 300,
        fromZoom: 2,
        toZoom: 0.5,
      }),
    ).toEqual({ left: 0, top: 0 });
  });

  it('uses the desktop zoom step as the ratio', () => {
    const to = stepZoom(1, 1);
    const next = anchoredScroll({
      scrollLeft: 0,
      scrollTop: 500,
      pointerX: 0,
      pointerY: 0,
      fromZoom: 1,
      toZoom: to,
    });
    expect(next.top).toBeCloseTo(500 * to);
  });
});
