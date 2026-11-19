import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACT_OPTIONS,
  MIN_MARK_PT,
  markRefsJson,
  redactionAreaJson,
  redactionRect,
} from './marks';

// The page box is drawn at 96/72 CSS pixels per point at zoom 1, so 96 CSS pixels are 72 points.
const PAGE = { widthPt: 612, heightPt: 792 };

describe('redactionRect (W7.4, the page points of a drag)', () => {
  it('maps a drag at zoom 1 to page points', () => {
    const rect = redactionRect({ x: 0, y: 0 }, { x: 96, y: 192 }, 1, PAGE.widthPt, PAGE.heightPt);
    expect(rect).toEqual({ x0: 0, y0: 0, x1: 72, y1: 144 });
  });

  it('maps the same page area at a larger zoom to the same page points', () => {
    const at2 = redactionRect({ x: 0, y: 0 }, { x: 192, y: 384 }, 2, PAGE.widthPt, PAGE.heightPt);
    const at1 = redactionRect({ x: 0, y: 0 }, { x: 96, y: 192 }, 1, PAGE.widthPt, PAGE.heightPt);
    expect(at2).toEqual(at1);
  });

  it('normalizes a drag made upwards and to the left', () => {
    const rect = redactionRect({ x: 96, y: 96 }, { x: 0, y: 0 }, 1, PAGE.widthPt, PAGE.heightPt);
    expect(rect).toEqual({ x0: 0, y0: 0, x1: 72, y1: 72 });
  });

  it('keeps the box on the page when the drag leaves it', () => {
    const rect = redactionRect(
      { x: 0, y: 0 },
      { x: 99999, y: 99999 },
      1,
      PAGE.widthPt,
      PAGE.heightPt,
    );
    expect(rect).toEqual({ x0: 0, y0: 0, x1: PAGE.widthPt, y1: PAGE.heightPt });
  });

  it('marks nothing for a click or a drag under the minimum size', () => {
    expect(
      redactionRect({ x: 5, y: 5 }, { x: 5, y: 5 }, 1, PAGE.widthPt, PAGE.heightPt),
    ).toBeNull();
    const short = (MIN_MARK_PT / 2) * (96 / 72);
    expect(
      redactionRect(
        { x: 10, y: 10 },
        { x: 10 + short, y: 10 + short },
        1,
        PAGE.widthPt,
        PAGE.heightPt,
      ),
    ).toBeNull();
  });
});

describe('the JSON the calls send', () => {
  it('sends a mark area as a page and a rect', () => {
    expect(redactionAreaJson(2, { x0: 1, y0: 2, x1: 3, y1: 4 })).toEqual({
      page: 2,
      rect: { x0: 1, y0: 2, x1: 3, y1: 4 },
    });
  });

  it('names each mark by its page and name only', () => {
    expect(markRefsJson([{ page: 0, name: 'a' }])).toEqual([{ page: 0, name: 'a' }]);
  });

  it('uses the desktop defaults for the apply options', () => {
    expect(DEFAULT_REDACT_OPTIONS).toEqual({ images: 'pixels', graphics: 'covered', text: true });
  });
});
