import { describe, expect, it } from 'vitest';
import type { TextStyleDto } from '../rpc/generated';
import {
  clampRound,
  DEFAULT_TEXT_STYLE,
  missingChars,
  openingStyle,
  styleChanged,
  toActionStyle,
} from './textStyle';

const style: TextStyleDto = {
  font: 'ABCDEF+Arial',
  size: 11.9734,
  color: { r: 1, g: 0.5, b: 0, a: 1 },
  bold: false,
  italic: false,
  align: 'left',
  line_height: 1.2,
  char_spacing: 0.25,
  word_spacing: 1,
};

describe('toActionStyle', () => {
  it('sends the font with a null reference, so the engine reuses or falls back as before', () => {
    expect(toActionStyle(style)).toEqual({ ...style, size: 12, font_ref: null });
  });

  it('clamps the size to 4 to 144 points and rounds it to 0.1', () => {
    expect(toActionStyle({ ...style, size: 2 }).size).toBe(4);
    expect(toActionStyle({ ...style, size: 400 }).size).toBe(144);
    expect(toActionStyle({ ...style, size: 10.46 }).size).toBe(10.5);
  });

  it('clamps the line spacing to 0.8 to 3 and rounds it to 0.01', () => {
    expect(toActionStyle({ ...style, line_height: 0.1 }).line_height).toBe(0.8);
    expect(toActionStyle({ ...style, line_height: 9 }).line_height).toBe(3);
    expect(toActionStyle({ ...style, line_height: 1.234 }).line_height).toBe(1.23);
  });

  it('passes the spacing through unchanged', () => {
    const sent = toActionStyle(style);
    expect(sent.char_spacing).toBe(0.25);
    expect(sent.word_spacing).toBe(1);
  });
});

describe('clampRound', () => {
  it('keeps the value inside the range and rounds to the digits', () => {
    expect(clampRound(5.44, { min: 4, max: 144, digits: 1 })).toBe(5.4);
    expect(clampRound(NaN, { min: 4, max: 144, digits: 1 })).toBeNaN();
  });
});

describe('styleChanged', () => {
  it('is false for the same style', () => {
    expect(styleChanged(style, { ...style })).toBe(false);
  });

  it.each([
    ['font', { font: 'Other' }],
    ['size', { size: 20 }],
    ['bold', { bold: true }],
    ['italic', { italic: true }],
    ['align', { align: 'center' as const }],
    ['line_height', { line_height: 1.5 }],
    ['char_spacing', { char_spacing: 1 }],
    ['word_spacing', { word_spacing: 2 }],
    ['colour', { color: { r: 0, g: 0, b: 0, a: 1 } }],
    ['colour alpha', { color: { r: 1, g: 0.5, b: 0, a: 0.5 } }],
  ])('is true when %s differs', (_name, change) => {
    expect(styleChanged(style, { ...style, ...change })).toBe(true);
  });
});

describe('openingStyle', () => {
  it('uses the default style for a block that reports none', () => {
    expect(openingStyle(null)).toBe(DEFAULT_TEXT_STYLE);
    expect(openingStyle(style)).toBe(style);
  });
});

describe('missingChars', () => {
  it('lists the characters as they are when there are few', () => {
    expect(missingChars('Ü€')).toEqual({ shown: 'Ü€', more: 0 });
  });

  it('shows at most 20 characters and counts the rest', () => {
    const chars = 'ЖЗИЙКЛМНОПРСТУФХЦЧШЩ'.concat('ЪЫЬ');
    expect(missingChars(chars)).toEqual({ shown: chars.slice(0, 20), more: 3 });
  });

  it('writes control and private-use characters as U+XXXX', () => {
    expect(missingChars('\u0007')).toEqual({ shown: 'U+0007U+E000', more: 0 });
  });
});
