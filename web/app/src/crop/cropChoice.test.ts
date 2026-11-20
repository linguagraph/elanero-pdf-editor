import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import type { PageSize } from '../rpc/generated';
import { checkCrop, POINTS_PER, type CropValues } from './cropChoice';

const LETTER: PageSize = { width: 612, height: 792, rotation: 0 };
const SMALL: PageSize = { width: 200, height: 300, rotation: 0 };

function values(patch: Partial<CropValues> = {}): CropValues {
  return {
    left: '0',
    top: '0',
    right: '0',
    bottom: '0',
    unit: 'pt',
    scope: 'all',
    range: '',
    ...patch,
  };
}

describe('units', () => {
  it('converts millimetres and inches to points', () => {
    expect(POINTS_PER.pt).toBe(1);
    expect(POINTS_PER.in).toBe(72);
    const check = checkCrop(values({ unit: 'mm', left: '10' }), [LETTER], 1);
    expect(check).toEqual({
      ok: true,
      args: { pages: [0], left: 28.35, top: 0, right: 0, bottom: 0 },
    });
    const inches = checkCrop(values({ unit: 'in', top: '1' }), [LETTER], 1);
    expect(inches.ok && inches.args.top).toBe(72);
  });
});

describe('margins', () => {
  it('reads an empty margin as 0', () => {
    const check = checkCrop(values({ left: '', right: ' 12.5 ' }), [LETTER], 1);
    expect(check.ok && check.args).toEqual({ pages: [0], left: 0, top: 0, right: 12.5, bottom: 0 });
  });

  it('refuses a negative margin', () => {
    const check = checkCrop(values({ top: '-4' }), [LETTER], 1);
    expect(check).toEqual({ ok: false, message: t('crop.error.negative') });
  });

  it('refuses a value that is not a number', () => {
    const check = checkCrop(values({ bottom: 'ten' }), [LETTER], 1);
    expect(check).toEqual({ ok: false, message: t('crop.error.number') });
  });

  it('refuses margins that leave less than 1 pt, naming the page', () => {
    const check = checkCrop(values({ left: '400', right: '400' }), [LETTER, SMALL], 1);
    expect(check).toEqual({ ok: false, message: t('crop.error.tooLarge', { page: 1 }) });
  });

  it('checks each chosen page with its own size', () => {
    const big = checkCrop(values({ scope: 'range', range: '1', top: '300' }), [LETTER, SMALL], 1);
    expect(big.ok).toBe(true);
    const small = checkCrop(values({ scope: 'range', range: '2', top: '300' }), [LETTER, SMALL], 1);
    expect(small).toEqual({ ok: false, message: t('crop.error.tooLarge', { page: 2 }) });
  });
});

describe('pages', () => {
  it('all pages crops every page, zero-based', () => {
    const check = checkCrop(values({ left: '1' }), [LETTER, SMALL, LETTER], 2);
    expect(check.ok && check.args.pages).toEqual([0, 1, 2]);
  });

  it('current page crops the page the view shows', () => {
    const check = checkCrop(values({ scope: 'current', left: '1' }), [LETTER, SMALL], 2);
    expect(check.ok && check.args.pages).toEqual([1]);
  });

  it('a current page outside the document is refused', () => {
    const check = checkCrop(values({ scope: 'current', left: '1' }), [LETTER], 3);
    expect(check).toEqual({ ok: false, message: t('crop.error.range') });
  });

  it('a range is read with the print rules: sorted, no duplicates', () => {
    const check = checkCrop(
      values({ scope: 'range', range: '3, 1-2, 2', left: '1' }),
      [LETTER, LETTER, LETTER],
      1,
    );
    expect(check.ok && check.args.pages).toEqual([0, 1, 2]);
  });

  it('an empty or out-of-range page list is refused', () => {
    expect(checkCrop(values({ scope: 'range', range: '' }), [LETTER], 1)).toEqual({
      ok: false,
      message: t('crop.error.range'),
    });
    expect(checkCrop(values({ scope: 'range', range: '5' }), [LETTER], 1)).toEqual({
      ok: false,
      message: t('crop.error.range'),
    });
  });
});
