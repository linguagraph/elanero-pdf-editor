// The text style of the paragraph editor's style bar (W6.8b slice 1, design sections 2 and 6). The bar
// edits one TextStyleDto, `current`; nothing reaches the engine until the editor commits. A commit
// sends `toActionStyle(current)` only when the style changed (`styleChanged`), so a text-only commit
// keeps the engine's own style exactly as before. The rules of the desktop's TextStyleBar.text_style()
// live here so they are tested in one place.
import type { ColorDto, TextStyleDto } from '../rpc/generated';

// The style a new block is set in: the desktop's DEFAULT_TEXT_STYLE (Helvetica 12, black, left,
// line height 1.2). The engine's AddText takes a style, not null, so the default is sent in full.
export const DEFAULT_TEXT_STYLE: TextStyleDto = {
  font: 'Helvetica',
  size: 12,
  color: { r: 0, g: 0, b: 0, a: 1 },
  bold: false,
  italic: false,
  align: 'left',
  line_height: 1.2,
  char_spacing: 0,
  word_spacing: 0,
};

// The style an editor opens with: the block's own, or the default for a block that reports none.
export function openingStyle(style: TextStyleDto | null): TextStyleDto {
  return style ?? DEFAULT_TEXT_STYLE;
}

// The wire form of a style. `font_ref` is always sent, as null: the picker that sets it is slice 2.
export interface TextStyleArg extends TextStyleDto {
  readonly font_ref: null;
}

// Sizes and spacing the engine accepts (the desktop's clamp, design section 2).
export const SIZE_RANGE = { min: 4, max: 144, digits: 1 } as const;
export const LINE_HEIGHT_RANGE = { min: 0.8, max: 3, digits: 2 } as const;

// `value` limited to [min, max] and rounded to `digits` decimals.
export function clampRound(
  value: number,
  range: { readonly min: number; readonly max: number; readonly digits: number },
): number {
  const limited = Math.min(range.max, Math.max(range.min, value));
  const factor = 10 ** range.digits;
  return Math.round(limited * factor) / factor;
}

// The style as the engine takes it: clamped and rounded as on the desktop. Spacing is passed through.
export function toActionStyle(style: TextStyleDto): TextStyleArg {
  return {
    font: style.font,
    font_ref: null,
    size: clampRound(style.size, SIZE_RANGE),
    color: style.color,
    bold: style.bold,
    italic: style.italic,
    align: style.align,
    line_height: clampRound(style.line_height, LINE_HEIGHT_RANGE),
    char_spacing: style.char_spacing,
    word_spacing: style.word_spacing,
  };
}

function sameColour(a: ColorDto, b: ColorDto): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

// Whether the bar changed the style since the editor opened (field by field, so a new field is
// listed here on purpose).
export function styleChanged(opening: TextStyleDto, current: TextStyleDto): boolean {
  return !(
    opening.font === current.font &&
    opening.size === current.size &&
    sameColour(opening.color, current.color) &&
    opening.bold === current.bold &&
    opening.italic === current.italic &&
    opening.align === current.align &&
    opening.line_height === current.line_height &&
    opening.char_spacing === current.char_spacing &&
    opening.word_spacing === current.word_spacing
  );
}

// The characters of a missing-glyph notice, for a person to read: at most 20, then the count of the
// rest. Control and private-use characters have no glyph to show, so they are written as U+XXXX.
const SHOWN_CHARS = 20;

export function missingChars(chars: string): { readonly shown: string; readonly more: number } {
  const list = Array.from(chars);
  const shown = list
    .slice(0, SHOWN_CHARS)
    .map((c) => {
      if (!/[\p{Cc}\p{Co}]/u.test(c)) return c;
      const code = c.codePointAt(0) ?? 0;
      return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join('');
  return { shown, more: Math.max(0, list.length - SHOWN_CHARS) };
}
