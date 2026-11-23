import { describe, expect, it } from 'vitest';
import { formatMegabytes } from '../i18n/format';
import { MAX_FONT_FILE_BYTES, type AddOutcome, type LibraryFont } from './fontLibrary';
import { describeAddOutcome } from './uploadMessages';
import { fontDto, libraryFont } from './testFontLibrary';

const MiB = 1024 * 1024;

function added(overrides: Parameters<typeof fontDto>[0] = {}): AddOutcome {
  const font: LibraryFont = libraryFont({
    id: 'a'.repeat(64),
    name: 'x.ttf',
    dto: fontDto(overrides),
  });
  return { kind: 'added', font };
}

function refused(code: string, details: Record<string, unknown> = {}): AddOutcome {
  return { kind: 'refused', code: code as 'OUT_OF_MEMORY', details };
}

const USED = 100 * MiB;

describe('describeAddOutcome', () => {
  it('a single face says it was added (status)', () => {
    expect(describeAddOutcome(added(), 'Sans.ttf', USED)).toEqual({
      tone: 'status',
      text: 'Sans.ttf was added.',
    });
  });

  it('a collection says how many faces were added', () => {
    const outcome = added({
      format: 'collection',
      faces: [
        {
          index: 0,
          family: 'A',
          style: 'Regular',
          weight: 400,
          italic: false,
          scripts: [],
          variable: false,
        },
        {
          index: 1,
          family: 'B',
          style: 'Regular',
          weight: 400,
          italic: false,
          scripts: [],
          variable: false,
        },
      ],
    });
    expect(describeAddOutcome(outcome, 'Both.ttc', USED).text).toBe(
      'Both.ttc was added (2 faces).',
    );
  });

  it('a collection with refused faces counts the usable and the refused ones', () => {
    const outcome = added({
      format: 'collection',
      refused: [{ index: 2, family: 'C', style: 'Regular', reason: 'restricted' }],
    });
    expect(describeAddOutcome(outcome, 'Set.ttc', USED).text).toBe(
      "Set.ttc: 1 of its 2 faces can't be embedded and left out.",
    );
  });

  it('an existing font says it is already added', () => {
    const font = libraryFont({ id: 'b'.repeat(64), name: 'x.ttf' });
    expect(describeAddOutcome({ kind: 'already', font }, 'x.ttf', USED)).toEqual({
      tone: 'status',
      text: 'x.ttf is already added.',
    });
  });

  it.each([
    ['unsupported', "Sans.ttf was added for this tab only: this browser can't keep fonts."],
    [
      'no-space',
      'Sans.ttf was added, but there is no room to keep it in this browser. It works until you close the tab.',
    ],
    [
      'failed',
      'Sans.ttf was added, but could not be kept in this browser. It works until you close the tab.',
    ],
  ] as const)('a font kept as %s is a status line', (reason, text) => {
    const font = libraryFont({ id: 'c'.repeat(64), name: 'Sans.ttf' });
    expect(describeAddOutcome({ kind: 'notKept', font, reason }, 'Sans.ttf', USED)).toEqual({
      tone: 'status',
      text,
    });
  });

  it('a file over the per-file limit is an alert naming the limit', () => {
    const limit = formatMegabytes(MAX_FONT_FILE_BYTES);
    expect(describeAddOutcome({ kind: 'tooLarge' }, 'Big.ttf', USED)).toEqual({
      tone: 'alert',
      text: `Big.ttf is larger than ${limit}, the most a font file can be.`,
    });
  });

  it('a FILE_TOO_LARGE from the worker is the same alert', () => {
    const limit = formatMegabytes(MAX_FONT_FILE_BYTES);
    expect(
      describeAddOutcome(
        refused('FILE_TOO_LARGE', { max_bytes: MAX_FONT_FILE_BYTES }),
        'Big.ttf',
        USED,
      ).text,
    ).toBe(`Big.ttf is larger than ${limit}, the most a font file can be.`);
  });

  it.each([
    ['woff', 'Web.woff is a web font (WOFF or WOFF2). Add the TTF or OTF file instead.'],
    [
      'no_usable_face',
      'Web.woff has no font that can be used for text (it may contain only pictures of characters).',
    ],
    ['too_many_faces', 'Web.woff holds too many fonts. Add the single font file you need.'],
    ['not_a_font', 'Web.woff is not a font file that can be read.'],
    ['unreadable', 'Web.woff is not a font file that can be read.'],
  ])('INVALID_FONT reason %s', (reason, text) => {
    const outcome = refused('INVALID_FONT', { reason });
    expect(describeAddOutcome(outcome, 'Web.woff', USED)).toEqual({ tone: 'alert', text });
  });

  it('FONT_NOT_EMBEDDABLE restricted says the licence does not allow it', () => {
    expect(
      describeAddOutcome(refused('FONT_NOT_EMBEDDABLE', { reason: 'restricted' }), 'R.ttf', USED),
    ).toEqual({
      tone: 'alert',
      text: "R.ttf can't be added: its licence does not allow embedding it in documents.",
    });
  });

  it('FONT_NOT_EMBEDDABLE bitmap_only says the licence allows pictures only', () => {
    expect(
      describeAddOutcome(refused('FONT_NOT_EMBEDDABLE', { reason: 'bitmap_only' }), 'B.ttf', USED),
    ).toEqual({
      tone: 'alert',
      text: "B.ttf can't be added: its licence allows embedding only as pictures.",
    });
  });

  it('FONT_STORAGE_FULL by count names the most fonts', () => {
    expect(
      describeAddOutcome(
        refused('FONT_STORAGE_FULL', { limit: 'count', max_fonts: 64 }),
        'N.ttf',
        USED,
      ),
    ).toEqual({
      tone: 'alert',
      text: 'N.ttf was not added: at most 64 fonts can be added. Remove fonts you no longer need.',
    });
  });

  it('FONT_STORAGE_FULL by bytes names the limit and what is used', () => {
    const max = formatMegabytes(256 * MiB);
    const used = formatMegabytes(USED);
    expect(
      describeAddOutcome(
        refused('FONT_STORAGE_FULL', { limit: 'bytes', max_bytes: 256 * MiB }),
        'N.ttf',
        USED,
      ),
    ).toEqual({
      tone: 'alert',
      text: `N.ttf was not added: fonts can use at most ${max}, and ${used} is used. Remove fonts you no longer need.`,
    });
  });

  it('NOT_SUPPORTED asks the user to reload', () => {
    expect(describeAddOutcome(refused('NOT_SUPPORTED'), 'N.ttf', USED)).toEqual({
      tone: 'alert',
      text: "Fonts can't be added because the font reader did not load. Reload the page.",
    });
  });

  it('any other failure says it could not be added', () => {
    expect(describeAddOutcome(refused('OUT_OF_MEMORY'), 'O.ttf', USED)).toEqual({
      tone: 'alert',
      text: 'O.ttf could not be added. Try again.',
    });
  });
});
