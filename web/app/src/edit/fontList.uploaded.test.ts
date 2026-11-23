// The Uploaded section's rules (W6.8b slice 3, design section 4.3): one row per catalogue family,
// the face Bold and Italic choose, and the preview id of an uploaded ref.
import { describe, expect, it } from 'vitest';
import { fontDto, libraryFont } from '../fonts/testFontLibrary';
import {
  faceToggle,
  findFace,
  fontSections,
  pickedStyle,
  selectedOption,
  UPLOAD_KEY,
  type UploadedFace,
  uploadedSection,
} from './fontList';
import { uploadedIdOf } from './uploadedPreview';
import { DEFAULT_TEXT_ARG, type FontRefArg, type TextStyleArg } from './textStyle';

const ID = 'b'.repeat(64);
const path = `/fonts/${ID}.ttf`;

function face(family: string, weight: number, italic: boolean, index = 0): UploadedFace {
  return { family, weight, italic, ref: { kind: 'file', name: family, path, index } };
}

const regular = face('Test Sans', 400, false);
const bold = face('Test Sans', 700, false, 1);
const italic = face('Test Sans', 400, true, 2);

describe('uploadedSection', () => {
  it('lists one row per loaded family, sorted by name, with the upload row last', () => {
    const section = uploadedSection([
      libraryFont({
        id: ID,
        name: 'Zeta.ttf',
        dto: fontDto({
          id: ID,
          path,
          faces: [
            {
              index: 0,
              family: 'Zeta',
              style: 'Regular',
              weight: 400,
              italic: false,
              scripts: [],
              variable: false,
            },
            {
              index: 1,
              family: 'Alpha',
              style: 'Bold',
              weight: 700,
              italic: false,
              scripts: [],
              variable: false,
            },
          ],
        }),
      }),
      libraryFont({
        id: 'c'.repeat(64),
        name: 'Alpha.otf',
        dto: fontDto({
          id: 'c'.repeat(64),
          path: `/fonts/${'c'.repeat(64)}.otf`,
          faces: [
            {
              index: 0,
              family: 'Alpha',
              style: 'Regular',
              weight: 400,
              italic: false,
              scripts: [],
              variable: false,
            },
          ],
        }),
      }),
    ]);
    const families = section.options.filter((o) => o.key !== UPLOAD_KEY);
    expect(families.map((o) => o.name)).toEqual(['Alpha', 'Zeta']);
    expect(families[0]?.faces?.map((f) => f.weight)).toEqual([700, 400]);
    expect(section.options.at(-1)?.key).toBe(UPLOAD_KEY);
  });

  it('leaves out fonts the engine does not hold yet', () => {
    const section = uploadedSection([
      libraryFont({ id: ID, name: 'Kept.ttf', loaded: false, dto: fontDto({ id: ID, path }) }),
      libraryFont({ id: ID, name: 'Bare.ttf', loaded: true, dto: undefined }),
    ]);
    expect(section.options.map((o) => o.key)).toEqual([UPLOAD_KEY]);
  });
});

describe('findFace', () => {
  const faces = [regular, bold, italic];
  it.each([
    [false, false, regular],
    [true, false, bold],
    [false, true, italic],
  ])('picks the face for bold=%s italic=%s', (b, i, want) => {
    expect(findFace(faces, b, i)).toEqual(want);
  });

  it('returns null for a family with no faces', () => {
    expect(findFace([], false, false)).toBeNull();
  });

  // Weight classes: 600 and up is bold. Regular is the nearest 400 and Semibold the nearest 700.
  const light = face('Weights', 300, false, 0);
  const regularW = face('Weights', 400, false, 1);
  const semibold = face('Weights', 600, false, 2);
  const black = face('Weights', 900, false, 3);
  const weights = [light, regularW, semibold, black];
  it.each([
    [false, false, regularW],
    [true, false, semibold],
  ])('breaks ties by weight for bold=%s italic=%s', (b, i, want) => {
    expect(findFace(weights, b, i)).toEqual(want);
  });

  // With no upright face, an italic-only family answers with its italic face for either bold.
  const italicOnly = [face('Slant', 400, true, 0)];
  it.each([
    [false, false, italicOnly[0]],
    [true, false, italicOnly[0]],
  ])('returns the only face of an italic-only family for bold=%s italic=%s', (b, i, want) => {
    expect(findFace(italicOnly, b, i)).toEqual(want);
  });
});

describe('faceToggle for an uploaded family', () => {
  const style = (over: Partial<TextStyleArg> = {}): TextStyleArg => ({
    ...DEFAULT_TEXT_ARG,
    font: 'Test Sans',
    font_ref: { kind: 'file', name: 'Test Sans', path, index: 0 } as FontRefArg,
    ...over,
  });

  it('switches to the bold face when a bold face exists', () => {
    const change = faceToggle(style(), 'bold', [], [regular, bold]);
    expect(change).toEqual({
      font: 'Test Sans',
      bold: true,
      italic: false,
      font_ref: bold.ref,
    });
  });

  it('is disabled when the family has no bold face', () => {
    expect(faceToggle(style(), 'bold', [], [regular, italic])).toBeNull();
  });

  it('is disabled for italic when no face is italic', () => {
    expect(faceToggle(style(), 'italic', [], [regular, bold])).toBeNull();
  });
});

describe('pickedStyle and selectedOption', () => {
  const section = uploadedSection([
    libraryFont({
      id: ID,
      name: 'Test.ttf',
      dto: fontDto({
        id: ID,
        path,
        faces: [
          {
            index: 0,
            family: 'Test Sans',
            style: 'Regular',
            weight: 400,
            italic: false,
            scripts: [],
            variable: false,
          },
          {
            index: 1,
            family: 'Test Sans',
            style: 'Bold',
            weight: 700,
            italic: false,
            scripts: [],
            variable: false,
          },
        ],
      }),
    }),
  ]);
  const option = section.options.find((o) => o.name === 'Test Sans');

  it('picks the face matching the current bold', () => {
    expect(option).toBeDefined();
    if (option === undefined) return;
    expect(pickedStyle(option, { bold: true, italic: false }).font_ref).toEqual({
      kind: 'file',
      name: 'Test Sans',
      path,
      index: 1,
    });
    expect(pickedStyle(option, { bold: false, italic: false }).font_ref?.index).toBe(0);
  });

  it('shows the family as the selected option for a file ref', () => {
    const shown = selectedOption([section], {
      ...DEFAULT_TEXT_ARG,
      font: 'Test Sans',
      font_ref: { kind: 'file', name: 'Test Sans', path, index: 0 },
    });
    expect(shown.key).toBe('up:Test Sans');
  });

  it('adds the Uploaded section only when the caller has the library', () => {
    expect(fontSections([], '').map((s) => s.id)).toEqual(['standard']);
    expect(fontSections([], '', []).map((s) => s.id)).toEqual(['standard', 'uploaded']);
  });
});

describe('uploadedIdOf', () => {
  it('reads the font id from a file ref, and nothing from other refs', () => {
    expect(uploadedIdOf({ kind: 'file', name: 'x', path, index: 0 })).toBe(ID);
    expect(uploadedIdOf({ kind: 'standard', name: 'Helvetica', path: '', index: 0 })).toBeNull();
    expect(uploadedIdOf(null)).toBeNull();
  });
});
