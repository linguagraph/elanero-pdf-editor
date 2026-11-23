// The font picker's options (W6.8b slice 2, design sections 4.1 and 4.2). "In this document" lists
// the fonts of the text blocks on the page being edited, from the object cache: the engine reuses a
// document font only on its own page, so a font from another page would silently fall back. The
// standard section is the three base-14 families the desktop lists. Pure functions only; the
// picker and the style bar render and act on them.
import type { LibraryFont } from '../fonts/fontLibrary';
import { t } from '../i18n/t';
import type { PageObjectDto } from '../rpc/generated';
import { type FontRefArg, standardRef, type StyleInput } from './textStyle';

export type FontSectionId = 'document' | 'standard' | 'uploaded';

// One face of an uploaded family (design section 4.3): what Bold and Italic choose between, and the
// FILE ref the engine reads it by.
export interface UploadedFace {
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly ref: FontRefArg;
}

// The key of the Uploaded section's "Upload font…" row: picking it opens the file dialog.
export const UPLOAD_KEY = 'upload';

// One font the picker can choose. `name` is what the style sends as `font`; `ref` is what it sends
// as `font_ref` (null for a document font, which the engine finds on the page by name). An uploaded
// family carries its `faces`: a pick takes the one matching the current bold and italic.
export interface FontOption {
  readonly key: string;
  readonly name: string;
  readonly label: string;
  readonly title: string;
  readonly ref: FontRefArg | null;
  readonly faces?: readonly UploadedFace[];
}

export interface FontSection {
  readonly id: FontSectionId;
  readonly heading: string;
  readonly options: readonly FontOption[];
}

// A subset font's name starts with a six-letter tag and "+" (ABCDEF+Arial-BoldMT).
const SUBSET_TAG = /^[A-Z]{6}\+/;
// A long name is cut for the list; the full name is in the option's tooltip.
const MAX_LABEL_CHARS = 64;

export function stripSubset(name: string): string {
  return name.replace(SUBSET_TAG, '');
}

// The face a font name stands for: its family and whether it is bold or italic. The style suffixes
// are the fixed list of design section 4.1; a name with another suffix (Light, Condensed) is not a
// face this rule knows, so it has no sibling.
const STYLE_FACES: Readonly<Record<string, { readonly bold: boolean; readonly italic: boolean }>> =
  {
    '': { bold: false, italic: false },
    Bold: { bold: true, italic: false },
    Bd: { bold: true, italic: false },
    Italic: { bold: false, italic: true },
    Oblique: { bold: false, italic: true },
    It: { bold: false, italic: true },
    BoldItalic: { bold: true, italic: true },
    BoldOblique: { bold: true, italic: true },
    BdIt: { bold: true, italic: true },
  };

// The PostScript suffixes MT and PS are part of the naming, not of the face.
const TRAILING_MT_PS = /(MT|PS)$/;

export function parseFace(name: string): {
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
} | null {
  const bare = stripSubset(name);
  const cut = Math.max(bare.lastIndexOf('-'), bare.lastIndexOf(','));
  const family = (cut < 0 ? bare : bare.slice(0, cut)).replace(TRAILING_MT_PS, '');
  const style = cut < 0 ? '' : bare.slice(cut + 1).replace(TRAILING_MT_PS, '');
  const face = STYLE_FACES[style];
  if (face === undefined || family === '') return null;
  return { family, ...face };
}

// The name on the page of the same family with the wanted weight and slant, or null when the page
// has none. Missing is safe: no face is offered rather than a wrong one.
export function siblingFont(
  name: string,
  bold: boolean,
  italic: boolean,
  pageFonts: readonly string[],
): string | null {
  const self = parseFace(name);
  if (self === null) return null;
  for (const other of pageFonts) {
    const face = parseFace(other);
    if (
      face !== null &&
      face.family === self.family &&
      face.bold === bold &&
      face.italic === italic
    )
      return other;
  }
  return null;
}

// The style change a Bold or Italic press makes, or null when the press can't change the text:
// a standard font has every face, but a document font switches to its sibling on the page.
export function faceToggle(
  style: StyleInput,
  which: 'bold' | 'italic',
  pageFonts: readonly string[],
  uploaded: readonly UploadedFace[] = [],
): Pick<StyleInput, 'font' | 'bold' | 'italic' | 'font_ref'> | null {
  const bold = which === 'bold' ? !style.bold : style.bold;
  const italic = which === 'italic' ? !style.italic : style.italic;
  if (style.font_ref?.kind === 'file') {
    // An uploaded family: Bold is offered when some face is bold (weight 600 or more), Italic when
    // some face is italic; the press takes the face of the family that matches.
    const faces = uploaded.filter((face) => face.family === style.font);
    const offered =
      which === 'bold'
        ? faces.some((face) => face.weight >= 600)
        : faces.some((face) => face.italic);
    const face = offered ? findFace(faces, bold, italic) : null;
    return face === null ? null : { font: style.font, bold, italic, font_ref: face.ref };
  }
  // A standard font, by ref or by its name (the default of new text), has all four faces.
  if (style.font_ref?.kind === 'standard' || (!style.font_ref && isStandardName(style.font))) {
    return { font: style.font, bold, italic };
  }
  const sibling = siblingFont(style.font, bold, italic, pageFonts);
  return sibling === null ? null : { font: sibling, bold, italic };
}

// The document font names of the sections, the list a toggle looks its siblings up in.
export function documentNames(sections: readonly FontSection[]): readonly string[] {
  return sections.find((s) => s.id === 'document')?.options.map((o) => o.name) ?? [];
}

// The option a document font of the page is listed as. The shown name is cut at 64 characters; a
// subset font says so, and its tooltip keeps the full name and the reason.
function documentOption(name: string): FontOption {
  const bare = stripSubset(name);
  const chars = Array.from(bare);
  const base =
    chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS).join('')}…` : bare;
  if (SUBSET_TAG.test(name)) {
    return {
      key: `doc:${name}`,
      name,
      label: t('fonts.picker.subset', { name: base }),
      title: `${name}. ${t('fonts.picker.subsetHint')}`,
      ref: null,
    };
  }
  return { key: `doc:${name}`, name, label: base, title: name, ref: null };
}

// The fonts of the text blocks on the page: the block's own font first, then the others in name
// order (case-insensitive, subset tag ignored). Each name is listed once.
export function documentSection(
  objects: readonly PageObjectDto[],
  blockFont: string,
): FontSection | null {
  const names = new Set<string>();
  for (const o of objects) {
    if (o.type === 'text' && o.style !== null && o.style.font !== '') names.add(o.style.font);
  }
  names.delete(blockFont);
  const others = [...names].sort((a, b) =>
    stripSubset(a).toLowerCase().localeCompare(stripSubset(b).toLowerCase()),
  );
  const ordered = blockFont === '' ? others : [blockFont, ...others];
  if (ordered.length === 0) return null;
  return {
    id: 'document',
    heading: t('fonts.picker.document'),
    options: ordered.map(documentOption),
  };
}

// The desktop's three standard families (design section 4.2). The names sent are fixed; the labels
// are the translated ones.
export function standardSection(): FontSection {
  const option = (name: string, label: string): FontOption => ({
    key: `std:${name}`,
    name,
    label,
    title: name,
    ref: standardRef(name),
  });
  return {
    id: 'standard',
    heading: t('fonts.picker.standard'),
    options: [
      option('Helvetica', t('fonts.picker.sans')),
      option('Times-Roman', t('fonts.picker.serif')),
      option('Courier', t('fonts.picker.mono')),
    ],
  };
}

// The Uploaded section (design section 4.3): one row per catalogue family, sorted by name, then the
// "Upload font…" row. A font counts once the engine holds it (loaded), since only then is its FILE
// ref one the engine can read. Refused faces are not in the font's dto.
export function uploadedSection(fonts: readonly LibraryFont[]): FontSection {
  const families = new Map<string, UploadedFace[]>();
  for (const font of fonts) {
    if (!font.loaded || font.dto === undefined) continue;
    for (const face of font.dto.faces) {
      const faces = families.get(face.family) ?? [];
      const ref: FontRefArg = {
        kind: 'file',
        name: face.family,
        path: font.dto.path,
        index: face.index,
      };
      faces.push({ family: face.family, weight: face.weight, italic: face.italic, ref });
      families.set(face.family, faces);
    }
  }
  const options: FontOption[] = [...families]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, faces]) => ({
      key: `up:${family}`,
      name: family,
      label: family,
      title: family,
      ref: null,
      faces,
    }));
  const upload = t('fonts.upload.button');
  options.push({ key: UPLOAD_KEY, name: '', label: upload, title: upload, ref: null });
  return { id: 'uploaded', heading: t('fonts.picker.uploaded'), options };
}

// The picker's sections for a page: the document section (when the page has text), the standard
// one, then the Uploaded section when the caller has the library (`uploaded` given, even empty).
export function fontSections(
  objects: readonly PageObjectDto[],
  blockFont: string,
  uploaded?: readonly LibraryFont[],
): FontSection[] {
  const document = documentSection(objects, blockFont);
  const sections: FontSection[] = document === null ? [] : [document];
  sections.push(standardSection());
  if (uploaded !== undefined) sections.push(uploadedSection(uploaded));
  return sections;
}

// Every uploaded face the sections offer, for Bold and Italic.
export function uploadedFaces(sections: readonly FontSection[]): readonly UploadedFace[] {
  return sections.flatMap((s) => s.options.flatMap((o) => o.faces ?? []));
}

// The face of a family that best matches bold and italic, scored as the desktop's catalogue does:
// the weight class first, then the slant, then the weight nearest 400 (or 700 for bold). Null when
// the family has no face.
export function findFace(
  faces: readonly UploadedFace[],
  bold: boolean,
  italic: boolean,
): UploadedFace | null {
  const target = bold ? 700 : 400;
  const cost = (face: UploadedFace) =>
    Number(face.weight >= 600 !== bold) * 1_000_000 +
    Number(face.italic !== italic) * 10_000 +
    Math.abs(face.weight - target);
  let best: UploadedFace | null = null;
  for (const face of faces) {
    if (best === null || cost(face) < cost(best)) best = face;
  }
  return best;
}

// What a pick sets: an uploaded family takes the face of the current bold and italic; any other
// option sets its own name and ref.
export function pickedStyle(
  option: FontOption,
  style: Pick<StyleInput, 'bold' | 'italic'>,
): Pick<StyleInput, 'font' | 'font_ref'> {
  if (option.faces === undefined) return { font: option.name, font_ref: option.ref };
  const face = findFace(option.faces, style.bold, style.italic);
  return { font: option.name, font_ref: face?.ref ?? null };
}

// The option the style shows. A standard font is found by its ref; a document font by its name,
// with a standard name (the default Helvetica of new text) shown as the standard family. A font the
// lists don't hold is shown by its name, so the bar never shows an empty control.
export function selectedOption(sections: readonly FontSection[], style: StyleInput): FontOption {
  const all = sections.flatMap((s) => s.options);
  if (style.font_ref?.kind === 'standard') {
    const byRef = all.find((o) => o.key === `std:${style.font_ref?.name ?? ''}`);
    if (byRef !== undefined) return byRef;
  }
  if (style.font_ref?.kind === 'file') {
    const byFamily = all.find((o) => o.key === `up:${style.font}`);
    if (byFamily !== undefined) return byFamily;
  }
  const standard = all.find((o) => o.ref !== null && o.name === style.font);
  if (!style.font_ref && standard !== undefined) return standard;
  const document = all.find((o) => o.key === `doc:${style.font}`);
  if (document !== undefined) return document;
  return {
    key: `doc:${style.font}`,
    name: style.font,
    label: stripSubset(style.font),
    title: style.font,
    ref: null,
  };
}

// Whether the font is one of the standard names, which the textarea previews in the browser's
// generic family (not in the document's face).
export function isStandardName(name: string): boolean {
  return name === 'Helvetica' || name === 'Times-Roman' || name === 'Courier';
}
