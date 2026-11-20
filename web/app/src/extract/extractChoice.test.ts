import { describe, expect, it } from 'vitest';
import { ReplyShapeError } from '../rpc/shape';
import {
  checkExtractPages,
  extractFontsArgs,
  extractImagesArgs,
  readExtractFontsValue,
  readExtractImagesValue,
} from './extractChoice';

describe('checkExtractPages', () => {
  it('takes every page as null', () => {
    expect(checkExtractPages('all', '', 5, 2)).toEqual({ ok: true, choice: { pages: null } });
  });

  it('takes the viewer page as its 0-based index', () => {
    expect(checkExtractPages('current', '', 5, 3)).toEqual({ ok: true, choice: { pages: [2] } });
  });

  it('takes the typed range, 0-based and in the order typed', () => {
    expect(checkExtractPages('range', '3, 1-2', 5, 1)).toEqual({
      ok: true,
      choice: { pages: [2, 0, 1] },
    });
  });

  it('refuses an empty range or a page outside the document, with a message', () => {
    const empty = checkExtractPages('range', '  ', 5, 1);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message.length).toBeGreaterThan(0);
    const outside = checkExtractPages('range', '9', 5, 1);
    expect(outside.ok).toBe(false);
  });
});

describe('extractImagesArgs', () => {
  it('sends the name and the pages, every field present', () => {
    expect(extractImagesArgs('a.pdf', { pages: null })).toEqual({ name: 'a.pdf', pages: null });
    expect(extractImagesArgs('a.pdf', { pages: [0, 2] })).toEqual({
      name: 'a.pdf',
      pages: [0, 2],
    });
  });
});

describe('readExtractImagesValue', () => {
  it('reads the count and the skipped images', () => {
    expect(readExtractImagesValue({ count: 3, too_large: 1 })).toEqual({ count: 3, tooLarge: 1 });
  });

  it('refuses a value of another shape', () => {
    expect(() => readExtractImagesValue({ count: 'three', too_large: 0 })).toThrow(ReplyShapeError);
    expect(() => readExtractImagesValue(null)).toThrow(ReplyShapeError);
    expect(() => readExtractImagesValue({ count: -1, too_large: 0 })).toThrow(ReplyShapeError);
  });
});

describe('extract_fonts arguments and value', () => {
  it('sends the document name only', () => {
    expect(extractFontsArgs('Report.pdf')).toEqual({ name: 'Report.pdf' });
  });

  it('reads the saved, not-embedded and refused fonts', () => {
    expect(
      readExtractFontsValue({
        saved: ['Free Sans.ttf'],
        not_embedded: ['Helvetica'],
        refused: [{ name: 'Restricted Sans', reason: 'restricted' }],
      }),
    ).toEqual({
      saved: ['Free Sans.ttf'],
      notEmbedded: ['Helvetica'],
      refused: [{ name: 'Restricted Sans', reason: 'restricted' }],
    });
  });

  it('refuses a value of another shape', () => {
    expect(() => readExtractFontsValue({ saved: 'x', not_embedded: [], refused: [] })).toThrow(
      ReplyShapeError,
    );
    expect(() =>
      readExtractFontsValue({ saved: [], not_embedded: [], refused: [{ name: 'A' }] }),
    ).toThrow(ReplyShapeError);
    expect(() => readExtractFontsValue(null)).toThrow(ReplyShapeError);
  });
});
