import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import {
  DEFAULT_SHAPE_STYLE,
  MAX_SHAPE_WIDTH,
  paintOf,
  parseShapeWidth,
  setShapeStyle,
  shapeStyleSummary,
  subscribeShapeStyle,
} from './shapeStyle';
import { shapeGesture } from './shapes';

const page = { widthPt: 600, heightPt: 800 };
const red = { r: 1, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 1 };

afterEach(() => {
  setShapeStyle(DEFAULT_SHAPE_STYLE);
});

describe('the shape style', () => {
  it('starts as the style every web shape had before: black, 1.5 pt, no fill', () => {
    expect(shapeGesture('rectangle', { x: 100, y: 500 }, { x: 200, y: 560 }, page)).toEqual({
      kind: 'rectangle',
      rect: { x0: 100, y0: 500, x1: 200, y1: 560 },
      stroke: { r: 0, g: 0, b: 0, a: 1 },
      fill: null,
      width: 1.5,
    });
  });

  it('is what the next shape of any kind is drawn with, and a line is never filled', () => {
    setShapeStyle({ outline: red, fill: blue, width: 6 });
    expect(shapeGesture('ellipse', { x: 100, y: 500 }, { x: 200, y: 560 }, page)).toMatchObject({
      stroke: { r: 1, g: 0, b: 0, a: 1 },
      fill: { r: 0, g: 0, b: 1, a: 1 },
      width: 6,
    });
    expect(shapeGesture('line', { x: 100, y: 100 }, { x: 300, y: 150 }, page)).toMatchObject({
      kind: 'line',
      stroke: { r: 1, g: 0, b: 0, a: 1 },
      fill: null,
      width: 6,
    });
  });

  it('tells its subscribers when it changes, and stops once they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeShapeStyle(listener);
    setShapeStyle({ outline: red, fill: null, width: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setShapeStyle(DEFAULT_SHAPE_STYLE);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('gives the engine the paint with alpha 1, and no fill when there is none', () => {
    expect(paintOf({ outline: red, fill: null, width: 3 })).toEqual({
      stroke: { r: 1, g: 0, b: 0, a: 1 },
      fill: null,
      width: 3,
    });
  });

  it('says the style in words, with the colours as hex', () => {
    expect(shapeStyleSummary({ outline: red, fill: blue, width: 6 })).toBe(
      t('edit.shape.styleSummary', { outline: '#ff0000', width: '6', fill: 'filled #0000ff' }),
    );
    expect(shapeStyleSummary(DEFAULT_SHAPE_STYLE)).toContain(t('edit.shape.noFill'));
  });
});

describe('parseShapeWidth', () => {
  it.each([
    ['1.5', 1.5],
    [' 0.25 ', 0.25],
    [String(MAX_SHAPE_WIDTH), MAX_SHAPE_WIDTH],
  ])('accepts %j', (text, value) => {
    expect(parseShapeWidth(text)).toBe(value);
  });

  it.each(['', '   ', '0', '-1', '72.01', '100', 'wide', 'NaN', 'Infinity'])(
    'refuses %j',
    (text) => {
      expect(parseShapeWidth(text)).toBeNull();
    },
  );
});
