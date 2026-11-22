import { describe, expect, it } from 'vitest';
import { backgroundFrom, canScrollBy, FALLBACK_BACKGROUND, readableColour } from './editorStyle';

const black = { r: 0, g: 0, b: 0, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };
const paleGrey = { r: 0.9, g: 0.9, b: 0.9, a: 1 };

describe('readableColour', () => {
  it('keeps the block colour on a background it reads on', () => {
    expect(readableColour(black, FALLBACK_BACKGROUND)).toBe('rgb(0 0 0)');
  });

  it('falls back to the theme text colour for light text on a light background', () => {
    expect(readableColour(paleGrey, FALLBACK_BACKGROUND)).toBe('var(--color-text)');
    expect(readableColour(white, '#ffffff')).toBe('var(--color-text)');
  });

  it('keeps the block colour when the background cannot be read as hex', () => {
    expect(readableColour(paleGrey, 'rgb(255, 246, 196)')).toBe('rgb(230 230 230)');
  });
});

describe('backgroundFrom', () => {
  it('uses the theme token when it is set, else the fallback', () => {
    expect(backgroundFrom(' #4a4424 ')).toBe('#4a4424');
    expect(backgroundFrom('')).toBe(FALLBACK_BACKGROUND);
  });
});

describe('canScrollBy', () => {
  // A textarea 100 px tall, with 300 px of text: it can scroll 200 px in total.
  it('scrolls down while it is not at the bottom, and up while it is not at the top', () => {
    expect(canScrollBy(0, 300, 100, 10)).toBe(true);
    expect(canScrollBy(199, 300, 100, 10)).toBe(false);
    expect(canScrollBy(50, 300, 100, -10)).toBe(true);
    expect(canScrollBy(0, 300, 100, -10)).toBe(false);
  });

  it('does not scroll a textarea that holds all its text', () => {
    expect(canScrollBy(0, 100, 100, 10)).toBe(false);
    expect(canScrollBy(0, 100, 100, -10)).toBe(false);
  });
});
