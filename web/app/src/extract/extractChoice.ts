// What the Extract Images dialog asks for, checked before any job starts (W4.15, W1.2 section 13).
// Pure: no engine, no DOM. The job takes its pages 0-based (as the export takes them); the dialog
// types pages 1-based, as the export dialog does.
import { parseRanges, rangeErrorMessage } from '../split/ranges';
import { ReplyShapeError, expectInteger, expectObject, field } from '../rpc/shape';

// Which pages: all of them, the page the viewer shows, or a range the user typed. The same three
// choices as the export dialog, so a user meets one set of page words.
export type ExtractPageMode = 'all' | 'current' | 'range';

export interface ExtractChoice {
  // 0-based pages in the order typed; null means every page.
  readonly pages: readonly number[] | null;
}

export type ExtractCheck =
  | { readonly ok: true; readonly choice: ExtractChoice }
  | { readonly ok: false; readonly message: string };

// Checks the page choice. A refused range gives the message to show, and nothing starts.
export function checkExtractPages(
  pageMode: ExtractPageMode,
  range: string,
  pageCount: number,
  currentPage: number,
): ExtractCheck {
  switch (pageMode) {
    case 'all':
      return { ok: true, choice: { pages: null } };
    case 'current':
      return { ok: true, choice: { pages: [currentPage - 1] } };
    case 'range': {
      const parsed = parseRanges(range, pageCount);
      if (!parsed.ok) return { ok: false, message: rangeErrorMessage(parsed.error) };
      return { ok: true, choice: { pages: parsed.parts.flat() } };
    }
  }
}

// The job arguments, as ExtractImagesArgs in webapi/dto.py takes them. Every field is sent.
export function extractImagesArgs(name: string, choice: ExtractChoice): Record<string, unknown> {
  return { name, pages: choice.pages === null ? null : [...choice.pages] };
}

// The job's value: the images saved, and the images skipped for their size (ExtractImagesValue).
export interface ExtractImagesValue {
  readonly count: number;
  readonly tooLarge: number;
}

// Reads the value of an extract_images reply. A reply of another shape is refused, not guessed.
export function readExtractImagesValue(value: unknown): ExtractImagesValue {
  const object = expectObject(value, 'result.value');
  const count = expectInteger(field(object, 'count', 'result.value'), 'result.value.count');
  const tooLarge = expectInteger(
    field(object, 'too_large', 'result.value'),
    'result.value.too_large',
  );
  if (count < 0 || tooLarge < 0) throw new ReplyShapeError('result.value', 'a negative count');
  return { count, tooLarge };
}
