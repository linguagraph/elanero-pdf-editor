import { describe, expect, it } from 'vitest';
import type { PageSize } from '../rpc/generated';
import { cropBoxRect, MIN_CROP_BOX_PT } from './cropBox';
import { marginsFromBox, withDrawnBox, type CropValues } from './cropChoice';

const LETTER: PageSize = { width: 612, height: 792, rotation: 0 };

// At zoom 1, 96 CSS pixels are 72 points.
describe('cropBoxRect', () => {
  it('gives the drag as a page rectangle in points, at any zoom', () => {
    const rect = cropBoxRect({ x: 96, y: 144 }, { x: 288, y: 288 }, 1, 612, 792);
    expect(rect).toEqual({ x0: 72, y0: 108, x1: 216, y1: 216 });
    // The same drawn at 200 % takes twice the offsets for the same points.
    expect(cropBoxRect({ x: 192, y: 288 }, { x: 576, y: 576 }, 2, 612, 792)).toEqual(rect);
  });

  it('normalises a drag that runs up and to the left', () => {
    const rect = cropBoxRect({ x: 288, y: 288 }, { x: 96, y: 144 }, 1, 612, 792);
    expect(rect).toEqual({ x0: 72, y0: 108, x1: 216, y1: 216 });
  });

  it('clamps the box to the page', () => {
    const rect = cropBoxRect({ x: -50, y: -50 }, { x: 96 * 1000, y: 96 * 1000 }, 1, 612, 792);
    expect(rect).toEqual({ x0: 0, y0: 0, x1: 612, y1: 792 });
  });

  it('draws nothing for a click or a drag too small to be a box', () => {
    expect(cropBoxRect({ x: 50, y: 50 }, { x: 50, y: 50 }, 1, 612, 792)).toBeNull();
    const thin = MIN_CROP_BOX_PT * (4 / 3) - 1;
    expect(cropBoxRect({ x: 50, y: 50 }, { x: 50 + thin, y: 300 }, 1, 612, 792)).toBeNull();
  });
});

describe('marginsFromBox', () => {
  it('measures the margins from the far edges of the page', () => {
    const rect = { x0: 72, y0: 108, x1: 216, y1: 216 };
    expect(marginsFromBox(rect, LETTER)).toEqual({ left: 72, top: 108, right: 396, bottom: 576 });
  });

  it('gives zero for a box that touches the page edges', () => {
    const rect = { x0: 0, y0: 0, x1: 612, y1: 792 };
    expect(marginsFromBox(rect, LETTER)).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });

  it('rounds to a hundredth of a point', () => {
    const rect = { x0: 10.123, y0: 0, x1: 600.456, y1: 792 };
    expect(marginsFromBox(rect, LETTER).left).toBe(10.12);
    expect(marginsFromBox(rect, LETTER).right).toBe(11.54);
  });
});

describe('withDrawnBox', () => {
  const kept: CropValues = {
    left: '1',
    top: '2',
    right: '3',
    bottom: '4',
    unit: 'mm',
    scope: 'all',
    range: '2-4',
  };

  it('puts the box margins in the form, in points, on its page', () => {
    const drawn = { page: 3, margins: { left: 72, top: 108, right: 396, bottom: 576 } };
    expect(withDrawnBox(kept, drawn)).toEqual({
      left: '72',
      top: '108',
      right: '396',
      bottom: '576',
      unit: 'pt',
      scope: 'current',
      range: '2-4',
    });
  });
});
