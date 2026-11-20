// The crop dialog's choices as pure functions (W4.11 S3): the margins as the form reads them, their
// conversion to points, the page scope, and the checks that run before the engine is called. The
// engine check stays authoritative (pages of one document can differ in size); this one only saves
// a round trip and names the page that would be too small.
import type { PageRect } from '../comments/coordinates';
import { parsePageRange } from '../print/printRange';
import { t } from '../i18n/t';
import type { PageSize } from '../rpc/generated';

export type CropUnit = 'pt' | 'mm' | 'in';
export const POINTS_PER: Readonly<Record<CropUnit, number>> = { pt: 1, mm: 72 / 25.4, in: 72 };

export type CropScope = 'all' | 'current' | 'range';

// What the form holds. Margins are text, as typed; an empty margin is 0.
export interface CropValues {
  readonly left: string;
  readonly top: string;
  readonly right: string;
  readonly bottom: string;
  readonly unit: CropUnit;
  readonly scope: CropScope;
  readonly range: string;
}

// Margins in points, visible space: the edges of a page the user sees.
export interface CropMargins {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

// A crop box drawn on a page (W4.11 S5): its margins, and the page it was drawn on (1-based, as the
// view reports pages).
export interface DrawnCrop {
  readonly page: number;
  readonly margins: CropMargins;
}

// The margins a box on a page leaves around it. The box is in the page's visible space, so its
// right and bottom margins are measured from the far edges. Rounded to 0.01 pt, as the form does.
export function marginsFromBox(
  rect: PageRect,
  size: { readonly width: number; readonly height: number },
): CropMargins {
  const side = (points: number) => Math.max(0, Math.round(points * 100) / 100);
  return {
    left: side(rect.x0),
    top: side(rect.y0),
    right: side(size.width - rect.x1),
    bottom: side(size.height - rect.y1),
  };
}

// The form after a drawn box: its margins, in points, on that page only (the scope is Current page,
// as the box was drawn on one page). The other fields, and the range text, are kept.
export function withDrawnBox(values: CropValues, drawn: DrawnCrop): CropValues {
  const { left, top, right, bottom } = drawn.margins;
  return {
    ...values,
    left: String(left),
    top: String(top),
    right: String(right),
    bottom: String(bottom),
    unit: 'pt',
    scope: 'current',
  };
}

// The arguments of `pages.crop_margins`: 0-based pages, margins in points (visible space).
export interface CropArgs {
  readonly pages: number[];
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export type CropCheck =
  { readonly ok: true; readonly args: CropArgs } | { readonly ok: false; readonly message: string };

// The engine refuses a page left narrower or shorter than this (actions/pages.py).
const MIN_SIDE_PT = 1;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;
const NEGATIVE_NUMBER = /^-\s*\d/;

type Margin =
  { readonly ok: true; readonly points: number } | { readonly ok: false; readonly message: string };

// One margin as the form reads it: empty is 0, a plain decimal is converted to points (rounded to
// 0.01 pt), anything else is refused with the message for its kind.
function readMargin(text: string, unit: CropUnit): Margin {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, points: 0 };
  if (NEGATIVE_NUMBER.test(trimmed)) return { ok: false, message: t('crop.error.negative') };
  if (!PLAIN_NUMBER.test(trimmed)) return { ok: false, message: t('crop.error.number') };
  const points = Math.round(Number(trimmed) * POINTS_PER[unit] * 100) / 100;
  return { ok: true, points };
}

// The pages the scope names, 0-based, or null when the scope names none (a bad range, or a current
// page outside the document).
function choosePages(
  values: CropValues,
  sizes: readonly PageSize[],
  currentPage: number,
): number[] | null {
  const count = sizes.length;
  if (values.scope === 'all') return count > 0 ? sizes.map((_, index) => index) : null;
  if (values.scope === 'current') {
    return Number.isInteger(currentPage) && currentPage >= 1 && currentPage <= count
      ? [currentPage - 1]
      : null;
  }
  const pages = parsePageRange(values.range, count);
  return pages === undefined || pages.length === 0 ? null : [...pages];
}

// Checks the form and builds the crop's arguments. Nothing is sent unless this returns ok.
export function checkCrop(
  values: CropValues,
  sizes: readonly PageSize[],
  currentPage: number /* 1-based, as the view reports it */,
): CropCheck {
  const left = readMargin(values.left, values.unit);
  const top = readMargin(values.top, values.unit);
  const right = readMargin(values.right, values.unit);
  const bottom = readMargin(values.bottom, values.unit);
  for (const margin of [left, top, right, bottom]) {
    if (!margin.ok) return { ok: false, message: margin.message };
  }
  const pages = choosePages(values, sizes, currentPage);
  if (pages === null) return { ok: false, message: t('crop.error.range') };
  const margins = {
    left: left.ok ? left.points : 0,
    top: top.ok ? top.points : 0,
    right: right.ok ? right.points : 0,
    bottom: bottom.ok ? bottom.points : 0,
  };
  for (const index of pages) {
    const size = sizes[index];
    if (size === undefined) return { ok: false, message: t('crop.error.range') };
    const tooWide = margins.left + margins.right > size.width - MIN_SIDE_PT;
    const tooTall = margins.top + margins.bottom > size.height - MIN_SIDE_PT;
    if (tooWide || tooTall)
      return { ok: false, message: t('crop.error.tooLarge', { page: index + 1 }) };
  }
  return { ok: true, args: { pages, ...margins } };
}
