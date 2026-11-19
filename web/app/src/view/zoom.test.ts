import { describe, expect, it } from 'vitest';
import {
  CSS_PX_PER_POINT,
  MAX_RENDER_SCALE_MILLI,
  MAX_ZOOM,
  MIN_ZOOM,
  quantizeScale,
  scaleMilli,
  stepZoom,
  ZOOM_STEPS,
} from './zoom';

describe('zoom steps (desktop ZOOM_STEPS)', () => {
  it('uses the desktop values and limits', () => {
    expect(ZOOM_STEPS[0]).toBe(0.1);
    expect(ZOOM_STEPS.at(-1)).toBe(64);
    expect(MIN_ZOOM).toBe(0.05);
    expect(MAX_ZOOM).toBe(64);
  });

  it('moves to the next and previous step', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.67, 1)).toBe(0.75);
  });

  it('clamps at the ends', () => {
    expect(stepZoom(64, 1)).toBe(64);
    expect(stepZoom(0.1, -1)).toBe(MIN_ZOOM);
  });
});

describe('device scale (W1.4 section 3)', () => {
  it('uses 96/72 CSS pixels per point', () => {
    expect(CSS_PX_PER_POINT).toBeCloseTo(4 / 3, 12);
  });

  it('quantizes to 2 % steps in thousandths, as the desktop does', () => {
    // 1.02^15 = 1.3459..., 1.02^35 = 1.9999...: the same rule as core/render_cache.quantize_scale.
    expect(quantizeScale(4 / 3)).toBe(1346);
    expect(quantizeScale(1)).toBe(1000);
    expect(quantizeScale(2)).toBe(2000);
    expect(quantizeScale(0.5)).toBe(500);
  });

  it('rejects a non-positive scale', () => {
    expect(() => quantizeScale(0)).toThrow(RangeError);
  });

  it('is zoom times 96/72 times the device pixel ratio', () => {
    // zoom 1 at DPR 1 is the physical size: 4/3 CSS px per point, quantized.
    expect(scaleMilli(1, 1)).toBe(quantizeScale(4 / 3));
    expect(scaleMilli(2, 2)).toBe(quantizeScale(((2 * 4) / 3) * 2));
    expect(scaleMilli(0.5, 1)).toBe(quantizeScale(0.5 * (4 / 3)));
  });

  it('clamps the render scale to the engine limit instead of asking for a refused render', () => {
    // zoom 64 at DPR 4 is device scale 341: over the 256 limit, so the render is clamped.
    expect(MAX_RENDER_SCALE_MILLI).toBe(256_000);
    expect(scaleMilli(64, 4)).toBe(MAX_RENDER_SCALE_MILLI);
  });

  it('leaves a normal zoom unchanged', () => {
    expect(scaleMilli(1, 1)).toBe(quantizeScale(4 / 3));
    expect(scaleMilli(64, 1)).toBe(quantizeScale(64 * (4 / 3)));
  });
});
