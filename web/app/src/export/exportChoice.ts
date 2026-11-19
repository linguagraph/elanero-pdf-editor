// What the export dialog asks for, checked before any job starts (W7.7, W1.5 section 10). Pure: no
// engine, no DOM. The job takes the formats by the names below, and pages 0-based (as the split
// takes them); the dialog types pages 1-based.
import { t } from '../i18n/t';
import { parseRanges, rangeErrorMessage } from '../split/ranges';

export const EXPORT_FORMATS = ['txt', 'md', 'html', 'docx', 'png', 'jpeg', 'tiff'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

// The image formats take a resolution; the text formats ignore it.
export const IMAGE_FORMATS: readonly ExportFormat[] = ['png', 'jpeg', 'tiff'];

// W1.4 section 11: 150 dpi by default, 300 dpi as the option. The dialog offers only these two.
export const EXPORT_DPI = [150, 300] as const;
export type ExportDpi = (typeof EXPORT_DPI)[number];

// Which pages: all of them, the page the viewer shows, or a range the user typed.
export type PageMode = 'all' | 'current' | 'range';

export interface ExportValues {
  readonly format: ExportFormat;
  readonly pageMode: PageMode;
  readonly range: string;
  readonly dpi: number;
}

export interface ExportChoice {
  readonly format: ExportFormat;
  // 0-based pages in the order typed; null means every page.
  readonly pages: readonly number[] | null;
  readonly dpi: ExportDpi;
}

export type ExportCheck =
  | { readonly ok: true; readonly choice: ExportChoice }
  | {
      readonly ok: false;
      readonly message: string;
    };

// Checks what the user chose. A refused value gives the message to show, and nothing starts.
// The current page is the one the viewer shows, so it is always in the document (1-based here).
export function checkExport(
  values: ExportValues,
  pageCount: number,
  currentPage: number,
): ExportCheck {
  if (IMAGE_FORMATS.includes(values.format) && !isDpi(values.dpi)) {
    return { ok: false, message: t('export.error.dpi') };
  }
  const dpi = isDpi(values.dpi) ? values.dpi : EXPORT_DPI[0];
  switch (values.pageMode) {
    case 'all':
      return { ok: true, choice: { format: values.format, pages: null, dpi } };
    case 'current':
      return {
        ok: true,
        choice: { format: values.format, pages: [currentPage - 1], dpi },
      };
    case 'range': {
      const parsed = parseRanges(values.range, pageCount);
      if (!parsed.ok) return { ok: false, message: rangeErrorMessage(parsed.error) };
      return {
        ok: true,
        choice: { format: values.format, pages: parsed.parts.flat(), dpi },
      };
    }
  }
}

function isDpi(value: number): value is ExportDpi {
  return (EXPORT_DPI as readonly number[]).includes(value);
}

// The job arguments, as ExportArgs in webapi/dto.py takes them. Every field is sent. Comments are
// drawn into the images (the job's default, as print does).
export function exportArgs(choice: ExportChoice): Record<string, unknown> {
  return {
    format: choice.format,
    pages: choice.pages === null ? null : [...choice.pages],
    dpi: choice.dpi,
    annotations: true,
  };
}
