import { describe, expect, it } from 'vitest';
import { parseZoomInput, ZOOM_PRESETS } from './zoomBox';

describe('parseZoomInput (the zoom box, W4.2a S5)', () => {
  it.each([
    ['150%', { zoom: 1.5 }],
    ['150', { zoom: 1.5 }],
    [' 150 % ', { zoom: 1.5 }],
    ['12.5%', { zoom: 0.125 }],
    ['5000%', { zoom: 50 }],
    ['99999%', { zoom: 64 }],
    ['0', { zoom: 0.05 }],
    ['Fit Width', { fit: 'width' }],
    ['fit page', { fit: 'page' }],
  ])('reads %j as %j', (text, expected) => {
    expect(parseZoomInput(text)).toEqual(expected);
  });

  it.each(['abc', '', '   ', '-5', '150%%', '1,5', '%'])('rejects %j', (text) => {
    expect(parseZoomInput(text)).toBeNull();
  });

  it('offers the desktop presets: the two fits, then 50 % to 400 %', () => {
    expect(ZOOM_PRESETS).toEqual(['fitWidth', 'fitPage', 0.5, 0.75, 1, 1.25, 1.5, 2, 4]);
  });
});
