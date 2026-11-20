import { describe, expect, it } from 'vitest';
import { onScrollbar, panTo } from './pan';

const START = { scrollLeft: 100, scrollTop: 200, x: 50, y: 50 };
const BIG = { maxLeft: 500, maxTop: 800 };

describe('panTo', () => {
  it('moves the content with the pointer: a drag right or down scrolls left or up', () => {
    expect(panTo(START, 80, 90, BIG)).toEqual({ left: 70, top: 160 });
  });

  it('moves the scroll the other way for a drag left or up', () => {
    expect(panTo(START, 20, 10, BIG)).toEqual({ left: 130, top: 240 });
  });

  it('keeps the scroll at 0 at the start and at the maximum at the end', () => {
    expect(panTo(START, 500, 500, BIG)).toEqual({ left: 0, top: 0 });
    expect(panTo(START, -2000, -2000, BIG)).toEqual({ left: 500, top: 800 });
  });

  it('is at 0 on both axes when the content fits (a zero maximum)', () => {
    expect(panTo(START, -300, -300, { maxLeft: 0, maxTop: 0 })).toEqual({ left: 0, top: 0 });
  });

  it('does not move for a press with no movement', () => {
    expect(panTo(START, 50, 50, BIG)).toEqual({ left: 100, top: 200 });
  });
});

describe('onScrollbar', () => {
  const rect = new DOMRect(10, 20, 300, 400);

  it('is true on the right scrollbar strip and the bottom one', () => {
    expect(onScrollbar(rect, 290, 380, 10 + 295, 100)).toBe(true);
    expect(onScrollbar(rect, 290, 380, 100, 20 + 385)).toBe(true);
  });

  it('is false on the content', () => {
    expect(onScrollbar(rect, 290, 380, 100, 100)).toBe(false);
  });
});
