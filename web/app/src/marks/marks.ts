// The page-mark calls of W7.3 (W1.5 section 9, W7.9 pattern): header & footer and Bates numbers,
// a text watermark, a background colour, and removing a kind. Each mutating call runs as an action
// job (W1.2 section 13), so it is one undo step with progress and Cancel. Nothing here draws on
// the page: the actions layer does (services/stamping.py), and the job applies what it returns.
//
// The validation helpers keep an action that would not execute from reaching the job. Such an
// action applies the copied document with nothing changed and still records an undo step.
import { type ActionJobDeps, type ActionJobOutcome, runActionJob } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import type { MessageId } from '../i18n/en';
import type {
  BackgroundSpecDto,
  HeaderFooterSpecDto,
  MarkDetailResult,
  MarkKind,
  MarkSummaryDto,
  WatermarkSpecDto,
} from '../rpc/generated';
import { type PrintScope, resolvePrintPages } from '../print/printRange';

export const HEADER_FOOTER_ACTION = 'marks.header_footer';
export const WATERMARK_ACTION = 'marks.watermark';
export const BACKGROUND_ACTION = 'marks.background';
export const REMOVE_ACTION = 'marks.remove';

// The page scope of a mark dialog is the print dialog's (all, current, or a typed range).
export type MarkScope = PrintScope;

export type MarkFont = 'helv' | 'hebo' | 'tiro' | 'tibo' | 'cour' | 'cobo';

// The six base-14 families the engine can draw (model.pages.FONTS). Others need a font upload.
export const MARK_FONTS: readonly { readonly value: MarkFont; readonly label: MessageId }[] = [
  { value: 'helv', label: 'marks.font.helv' },
  { value: 'hebo', label: 'marks.font.hebo' },
  { value: 'tiro', label: 'marks.font.tiro' },
  { value: 'tibo', label: 'marks.font.tibo' },
  { value: 'cour', label: 'marks.font.cour' },
  { value: 'cobo', label: 'marks.font.cobo' },
];

export const MARK_KIND_LABELS: Readonly<Record<MarkKind, MessageId>> = {
  HeaderFooter: 'marks.kind.HeaderFooter',
  Bates: 'marks.kind.Bates',
  Watermark: 'marks.kind.Watermark',
  Background: 'marks.kind.Background',
};

// The ranges the desktop dialogs accept (ui/dialogs/pages.py), so a value the web refuses is one
// the desktop refuses too. Opacity is a fraction here (the desktop shows 5 to 100 %).
export const MARK_LIMITS = {
  fontSize: { min: 4, max: 72 }, // header & footer text
  watermarkSize: { min: 6, max: 400 },
  opacity: { min: 0.05, max: 1 },
  angle: { min: -180, max: 180 },
  margin: { min: 0, max: 500 },
  batesStart: { min: 0, max: 1_000_000_000 },
  batesDigits: { min: 1, max: 15 },
} as const;

export type HeaderFooterSlot =
  | 'header_left'
  | 'header_center'
  | 'header_right'
  | 'footer_left'
  | 'footer_center'
  | 'footer_right';

// The header & footer dialog's form. `bates` is read only in Bates mode.
export interface HeaderFooterForm {
  readonly texts: Readonly<Partial<Record<HeaderFooterSlot, string>>>;
  readonly font: MarkFont;
  readonly fontSize: number;
  readonly color: string; // #rrggbb
  readonly marginX: number;
  // One field for the top and the bottom margin, as the desktop has it (W7.3 question 6).
  readonly marginY: number;
  readonly bates: BatesForm;
}

export interface BatesForm {
  readonly prefix: string;
  readonly start: number;
  readonly digits: number;
  readonly suffix: string;
}

export interface WatermarkForm {
  readonly text: string;
  readonly font: MarkFont;
  readonly fontSize: number;
  readonly color: string; // #rrggbb
  readonly opacity: number; // a fraction, 0.05 to 1
  readonly angle: number;
  readonly onTop: boolean;
}

export interface BackgroundForm {
  readonly color: string; // #rrggbb
  readonly opacity: number; // a fraction, 0.05 to 1
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const SLOTS: readonly HeaderFooterSlot[] = [
  'header_left',
  'header_center',
  'header_right',
  'footer_left',
  'footer_center',
  'footer_right',
];

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

// Parses "#rrggbb" into the engine's colour, each channel from 0 to 1. Undefined for anything else.
export function hexToColor(hex: string): Rgb | undefined {
  const match = HEX.exec(hex);
  if (match === null) return undefined;
  const [r, g, b] = [match[1], match[2], match[3]].map((pair) => Number.parseInt(pair ?? '', 16));
  return { r: (r ?? 0) / 255, g: (g ?? 0) / 255, b: (b ?? 0) / 255 };
}

// The inverse of hexToColor: a stored colour as "#rrggbb" for the colour field.
export function colorToHex(color: Rgb): string {
  const channel = (value: number): string =>
    Math.round(Math.min(1, Math.max(0, value)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function isFiniteIn(value: number, low: number, high: number): boolean {
  return Number.isFinite(value) && value >= low && value <= high;
}

function inLimit(value: number, limit: { readonly min: number; readonly max: number }): boolean {
  return isFiniteIn(value, limit.min, limit.max);
}

// The zero-based pages a scope names, or undefined when a typed range is not valid.
export function markPages(
  scope: MarkScope,
  rangeText: string,
  pageCount: number,
  currentPage: number,
): readonly number[] | undefined {
  const resolved = resolvePrintPages(scope, rangeText, pageCount, currentPage);
  if (!resolved.ok) return undefined;
  return resolved.pages ?? Array.from({ length: pageCount }, (_, index) => index);
}

// Drops the slots that are empty or blank; the engine draws only what is left.
function nonEmptyTexts(
  texts: Readonly<Partial<Record<HeaderFooterSlot, string>>>,
): Partial<Record<HeaderFooterSlot, string>> {
  const kept: Partial<Record<HeaderFooterSlot, string>> = {};
  for (const slot of SLOTS) {
    const text = texts[slot];
    if (text !== undefined && text.trim() !== '') kept[slot] = text;
  }
  return kept;
}

export type HeaderFooterArgs = {
  spec: {
    texts: Partial<Record<HeaderFooterSlot, string>>;
    font: MarkFont;
    font_size: number;
    color: Rgb;
    margin_x: number;
    margin_top: number;
    margin_bottom: number;
    bates_prefix: string;
    bates_start: number;
    bates_digits: number;
    bates_suffix: string;
  };
  pages: readonly number[];
  file_name: string;
  bates: boolean;
  replace_existing: boolean;
};

// The argument of marks.header_footer. The Bates fields are always sent, as the desktop dialog
// always sends them: a `<<bates>>` in a plain header then uses the user's prefix and start, not the
// engine's defaults. The colour must already be valid (see canRunHeaderFooter).
export function headerFooterArgs(
  form: HeaderFooterForm,
  pages: readonly number[],
  fileName: string,
  bates: boolean,
  replace: boolean,
): HeaderFooterArgs {
  const color = hexToColor(form.color) ?? { r: 0, g: 0, b: 0 };
  return {
    spec: {
      texts: nonEmptyTexts(form.texts),
      font: form.font,
      font_size: form.fontSize,
      color,
      margin_x: form.marginX,
      margin_top: form.marginY,
      margin_bottom: form.marginY,
      bates_prefix: form.bates.prefix,
      bates_start: form.bates.start,
      bates_digits: form.bates.digits,
      bates_suffix: form.bates.suffix,
    },
    pages,
    file_name: fileName,
    bates,
    replace_existing: replace,
  };
}

export type WatermarkArgs = {
  spec: {
    text: string;
    font: MarkFont;
    font_size: number;
    color: Rgb;
    opacity: number;
    angle: number;
    on_top: boolean;
  };
  pages: readonly number[];
  replace_existing: boolean;
};

// The argument of marks.watermark. Text only: an image watermark needs the job's buffers.
export function watermarkArgs(
  form: WatermarkForm,
  pages: readonly number[],
  replace: boolean,
): WatermarkArgs {
  const color = hexToColor(form.color) ?? { r: 0, g: 0, b: 0 };
  return {
    spec: {
      text: form.text,
      font: form.font,
      font_size: form.fontSize,
      color,
      opacity: form.opacity,
      angle: form.angle,
      on_top: form.onTop,
    },
    pages,
    replace_existing: replace,
  };
}

export type BackgroundArgs = {
  color: Rgb;
  opacity: number;
  pages: readonly number[];
  replace_existing: boolean;
};

// The argument of marks.background (a colour only: the engine paints no image).
export function backgroundArgs(
  hex: string,
  opacity: number,
  pages: readonly number[],
  replace: boolean,
): BackgroundArgs {
  return {
    color: hexToColor(hex) ?? { r: 1, g: 1, b: 1 },
    opacity,
    pages,
    replace_existing: replace,
  };
}

// The argument of marks.remove.
export function removeArgs(kind: MarkKind): { kind: MarkKind } {
  return { kind };
}

// Whether the header & footer (or Bates) form can run. Refused: no text in any slot, no pages,
// a font size, a colour that is not #rrggbb, Bates digits or start, or a margin outside the
// desktop's ranges (MARK_LIMITS).
export function canRunHeaderFooter(form: HeaderFooterForm, pages: readonly number[]): boolean {
  if (pages.length === 0) return false;
  if (Object.keys(nonEmptyTexts(form.texts)).length === 0) return false;
  if (!inLimit(form.fontSize, MARK_LIMITS.fontSize)) return false;
  if (hexToColor(form.color) === undefined) return false;
  if (!inLimit(form.marginX, MARK_LIMITS.margin)) return false;
  if (!inLimit(form.marginY, MARK_LIMITS.margin)) return false;
  if (
    !Number.isInteger(form.bates.digits) ||
    !inLimit(form.bates.digits, MARK_LIMITS.batesDigits)
  ) {
    return false;
  }
  return Number.isInteger(form.bates.start) && inLimit(form.bates.start, MARK_LIMITS.batesStart);
}

// Whether the watermark form can run: text that is not blank, pages, a valid colour, a size,
// an angle and an opacity inside the desktop's ranges.
export function canRunWatermark(form: WatermarkForm, pages: readonly number[]): boolean {
  if (pages.length === 0) return false;
  if (form.text.trim() === '') return false;
  if (hexToColor(form.color) === undefined) return false;
  if (!inLimit(form.fontSize, MARK_LIMITS.watermarkSize)) return false;
  if (!inLimit(form.angle, MARK_LIMITS.angle)) return false;
  return inLimit(form.opacity, MARK_LIMITS.opacity);
}

// Whether the background colour can run: pages, a valid colour, and an opacity inside the range.
export function canRunBackground(hex: string, opacity: number, pages: readonly number[]): boolean {
  return pages.length > 0 && hexToColor(hex) !== undefined && inLimit(opacity, MARK_LIMITS.opacity);
}

// The kinds of mark the document already has, with how many pages carry each. Read before the
// dialog is shown, so Replace and Remove appear only when there is something to act on.
export async function listMarks(rpc: PageRpc, handle: string): Promise<readonly MarkSummaryDto[]> {
  const reply = await rpc.call('marks.list', { handle });
  return reply.items;
}

// One kind of mark with the settings it was added with (read-only, instant).
export function getMark(rpc: PageRpc, handle: string, kind: MarkKind): Promise<MarkDetailResult> {
  return rpc.call('marks.get', { handle, kind });
}

// What an Update dialog opens with: the stored settings in the dialog's form, the pages and their
// range text, and the notes the dialog shows. Undefined when the document has no such mark.
export interface MarkPreFill {
  readonly pages: readonly number[];
  readonly ranges: string;
  readonly foreign: boolean;
  readonly fontDropped: boolean;
  readonly headerFooter?: HeaderFooterForm;
  readonly watermark?: {
    readonly form: WatermarkForm;
    readonly image: boolean;
    readonly imageName: string;
    readonly scale: number;
  };
  readonly background?: BackgroundForm;
}

function fontOf(code: string): MarkFont {
  const known = MARK_FONTS.find((font) => font.value === code);
  return known?.value ?? 'helv';
}

function headerFooterForm(spec: HeaderFooterSpecDto): HeaderFooterForm {
  return {
    texts: {
      header_left: spec.header_left,
      header_center: spec.header_center,
      header_right: spec.header_right,
      footer_left: spec.footer_left,
      footer_center: spec.footer_center,
      footer_right: spec.footer_right,
    },
    font: fontOf(spec.font),
    fontSize: spec.font_size,
    color: colorToHex(spec.color),
    marginX: spec.margin_x,
    // The desktop has one margin field; a stored top and bottom that differ show the top one.
    marginY: spec.margin_top,
    bates: {
      prefix: spec.bates_prefix,
      start: spec.bates_start,
      digits: spec.bates_digits,
      suffix: spec.bates_suffix,
    },
  };
}

function watermarkForm(spec: WatermarkSpecDto): WatermarkForm {
  return {
    text: spec.text,
    font: fontOf(spec.font),
    fontSize: spec.font_size,
    color: colorToHex(spec.color),
    opacity: spec.opacity,
    angle: spec.angle,
    onTop: spec.on_top,
  };
}

function backgroundForm(spec: BackgroundSpecDto): BackgroundForm {
  return { color: colorToHex(spec.color), opacity: spec.opacity };
}

// The dialog's form from a marks.get reply (so Update opens with the stored values). Undefined
// when the kind is not in the document; a kind whose settings cannot be read has no form part.
export function fromMarkDetail(detail: MarkDetailResult): MarkPreFill | undefined {
  if (!detail.found) return undefined;
  const pre: MarkPreFill = {
    pages: detail.pages,
    ranges: detail.ranges,
    foreign: detail.foreign,
    fontDropped: detail.font_dropped,
    ...(detail.header_footer ? { headerFooter: headerFooterForm(detail.header_footer) } : {}),
    ...(detail.watermark
      ? {
          watermark: {
            form: watermarkForm(detail.watermark),
            image: detail.watermark.image,
            imageName: detail.watermark.image_name,
            scale: detail.watermark.scale,
          },
        }
      : {}),
    ...(detail.background ? { background: backgroundForm(detail.background) } : {}),
  };
  return pre;
}

// Runs one mark action as a mutating job. Resolves with the outcome; rejects with an RpcError or
// ActionJobCancelled, as the job runner does.
export function runMark(
  deps: ActionJobDeps,
  handle: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ActionJobOutcome> {
  return runActionJob(deps, handle, name, args);
}
