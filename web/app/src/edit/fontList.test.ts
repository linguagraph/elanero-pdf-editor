// The font picker's pure rules (W6.8b slice 2, design section 4): the page's document fonts, the
// sibling face of a Bold or Italic press, and the option the bar shows.
import { describe, expect, it } from 'vitest';
import type { PageObjectDto } from '../rpc/generated';
import {
  documentSection,
  faceToggle,
  fontSections,
  parseFace,
  selectedOption,
  siblingFont,
} from './fontList';
import { DEFAULT_TEXT_ARG, standardRef, type TextStyleArg } from './textStyle';

function text(font: string, key = font): PageObjectDto {
  return {
    type: 'text',
    key,
    bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
    text: 'x',
    style: { ...DEFAULT_TEXT_ARG, font },
    editable: true,
    reason: '',
    image_size: [0, 0],
    stroke: false,
    fill: false,
  };
}

const doc = (objects: PageObjectDto[], blockFont: string) =>
  documentSection(objects, blockFont)?.options.map((o) => o.name) ?? [];

describe('parseFace', () => {
  it.each([
    ['ABCDEF+Arial-BoldMT', 'Arial', true, false],
    ['TimesNewRomanPS-ItalicMT', 'TimesNewRoman', false, true],
    ['Calibri,Bold', 'Calibri', true, false],
    ['Foo-BdIt', 'Foo', true, true],
    ['Helvetica', 'Helvetica', false, false],
    ['Arial-BoldItalic', 'Arial', true, true],
  ])('reads %s as %s bold=%s italic=%s', (name, family, bold, italic) => {
    expect(parseFace(name)).toEqual({ family, bold, italic });
  });

  it('gives no face for a suffix the rule does not know', () => {
    expect(parseFace('Foo-Light')).toBeNull();
  });
});

describe('siblingFont', () => {
  it('finds the same family in the wanted weight or slant on the page', () => {
    const page = ['ABCDEF+Arial-BoldMT', 'ABCDEF+Arial-ItalicMT'];
    expect(siblingFont('ABCDEF+Arial', true, false, page)).toBe('ABCDEF+Arial-BoldMT');
    expect(siblingFont('ABCDEF+Arial-BoldMT', false, true, page)).toBe('ABCDEF+Arial-ItalicMT');
  });

  it('gives null when the page has only a sibling of the other slant or family', () => {
    expect(siblingFont('Calibri', true, false, ['Calibri-Italic', 'Arial-Bold'])).toBeNull();
  });
});

describe('documentSection', () => {
  it('lists the block font first, then the others in name order, each once', () => {
    const objects = [text('Zeta'), text('alpha'), text('Zeta'), text('Beta')];
    expect(doc(objects, 'Zeta')).toEqual(['Zeta', 'alpha', 'Beta']);
  });

  it('shows a subset font without its tag and says so, keeping the name for the ref', () => {
    const [option] = documentSection([text('ABCDEF+Arial')], 'ABCDEF+Arial')?.options ?? [];
    expect(option?.name).toBe('ABCDEF+Arial');
    expect(option?.label).toBe('Arial (subset)');
    expect(option?.title).toContain('Only part of this font');
    expect(option?.ref).toBeNull();
  });

  it('cuts a long name to 64 characters with an ellipsis, the full name in the tooltip', () => {
    const long = 'N'.repeat(70);
    const [option] = documentSection([text(long)], long)?.options ?? [];
    expect(option?.label).toBe(`${'N'.repeat(64)}…`);
    expect(option?.title).toBe(long);
  });

  it('gives no section for a page without text', () => {
    expect(documentSection([], '')).toBeNull();
    expect(fontSections([], '').map((s) => s.id)).toEqual(['standard']);
  });
});

describe('faceToggle', () => {
  const style = (over: Partial<TextStyleArg>): TextStyleArg => ({ ...DEFAULT_TEXT_ARG, ...over });

  it('always flips a standard font, which has all four faces', () => {
    const picked = style({ font: 'Times-Roman', font_ref: standardRef('Times-Roman') });
    expect(faceToggle(picked, 'bold', [])).toEqual({
      font: 'Times-Roman',
      bold: true,
      italic: false,
    });
  });

  it('treats the default Helvetica of new text as standard', () => {
    expect(faceToggle(style({}), 'italic', [])).toEqual({
      font: 'Helvetica',
      bold: false,
      italic: true,
    });
  });

  it('switches a document font to its sibling on the page, or gives null', () => {
    const base = style({ font: 'ABCDEF+Arial' });
    expect(faceToggle(base, 'bold', ['ABCDEF+Arial', 'ABCDEF+Arial-BoldMT'])).toEqual({
      font: 'ABCDEF+Arial-BoldMT',
      bold: true,
      italic: false,
    });
    expect(faceToggle(base, 'bold', ['ABCDEF+Arial'])).toBeNull();
  });
});

describe('selectedOption', () => {
  it('shows a standard font by its ref and a document font by its name', () => {
    const sections = fontSections([text('Calibri')], 'Calibri');
    const standard = selectedOption(sections, {
      ...DEFAULT_TEXT_ARG,
      font: 'Courier',
      font_ref: standardRef('Courier'),
    });
    expect(standard.key).toBe('std:Courier');
    expect(selectedOption(sections, { ...DEFAULT_TEXT_ARG, font: 'Calibri' }).key).toBe(
      'doc:Calibri',
    );
  });

  it('shows a font the lists do not hold by its name, so the control is never empty', () => {
    const option = selectedOption(fontSections([], ''), { ...DEFAULT_TEXT_ARG, font: 'Gone' });
    expect(option.label).toBe('Gone');
  });
});
