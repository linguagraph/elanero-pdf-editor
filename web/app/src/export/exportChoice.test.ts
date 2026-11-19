import { describe, expect, it } from 'vitest';
import { t, tp } from '../i18n/t';
import { checkExport, exportArgs, type ExportValues } from './exportChoice';

const base: ExportValues = { format: 'txt', pageMode: 'all', range: '', dpi: 150 };

function values(patch: Partial<ExportValues>): ExportValues {
  return { ...base, ...patch };
}

describe('checkExport', () => {
  it('exports every page as null, so the job takes all of them', () => {
    const checked = checkExport(values({}), 10, 1);
    expect(checked).toEqual({
      ok: true,
      choice: { format: 'txt', pages: null, dpi: 150 },
    });
  });

  it('exports the current page as its 0-based index', () => {
    const checked = checkExport(values({ format: 'png', pageMode: 'current' }), 10, 4);
    expect(checked).toEqual({ ok: true, choice: { format: 'png', pages: [3], dpi: 150 } });
  });

  it('turns a typed range into 0-based pages in the order typed', () => {
    const checked = checkExport(values({ pageMode: 'range', range: '1-3, 5' }), 10, 1);
    expect(checked).toMatchObject({ ok: true, choice: { pages: [0, 1, 2, 4] } });
  });

  it('refuses an empty range with a message, and starts nothing', () => {
    const checked = checkExport(values({ pageMode: 'range', range: '  ' }), 10, 1);
    expect(checked).toEqual({ ok: false, message: t('split.error.ranges.empty') });
  });

  it('refuses a range outside the document', () => {
    const checked = checkExport(values({ pageMode: 'range', range: '3-12' }), 10, 1);
    expect(checked).toEqual({
      ok: false,
      message: tp('split.error.ranges.outOfRange', 10, { item: '3-12' }),
    });
  });

  it('refuses a range that is not a page or span', () => {
    const checked = checkExport(values({ pageMode: 'range', range: '2,x' }), 10, 1);
    expect(checked).toEqual({
      ok: false,
      message: t('split.error.ranges.invalid', { item: 'x' }),
    });
  });

  it('refuses a dpi other than 150 or 300 for an image format', () => {
    const checked = checkExport(values({ format: 'jpeg', dpi: 72 }), 10, 1);
    expect(checked).toEqual({ ok: false, message: t('export.error.dpi') });
  });

  it('accepts 300 dpi for an image format', () => {
    const checked = checkExport(values({ format: 'tiff', dpi: 300 }), 10, 1);
    expect(checked).toMatchObject({ ok: true, choice: { format: 'tiff', dpi: 300 } });
  });

  it('ignores the dpi for a text format', () => {
    const checked = checkExport(values({ format: 'md', dpi: 72 }), 10, 1);
    expect(checked).toMatchObject({ ok: true, choice: { format: 'md', dpi: 150 } });
  });
});

describe('exportArgs', () => {
  it('sends every field the job takes, with the page list as an array', () => {
    const checked = checkExport(
      values({ format: 'png', pageMode: 'range', range: '2', dpi: 300 }),
      5,
      1,
    );
    if (!checked.ok) throw new Error('expected a choice');
    expect(exportArgs(checked.choice)).toEqual({
      format: 'png',
      pages: [1],
      dpi: 300,
      annotations: true,
    });
  });

  it('sends null for every page', () => {
    const checked = checkExport(values({ format: 'docx' }), 5, 1);
    if (!checked.ok) throw new Error('expected a choice');
    expect(exportArgs(checked.choice)).toMatchObject({ format: 'docx', pages: null });
  });
});
