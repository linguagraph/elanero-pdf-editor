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
import type { MarkKind, MarkSummaryDto } from '../rpc/generated';
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
  readonly marginTop: number;
  readonly marginBottom: number;
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
  readonly opacity: number;
  readonly angle: number;
  readonly onTop: boolean;
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

function isFiniteIn(value: number, low: number, high: number): boolean {
  return Number.isFinite(value) && value >= low && value <= high;
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
    bates_prefix?: string;
    bates_start?: number;
    bates_digits?: number;
    bates_suffix?: string;
  };
  pages: readonly number[];
  file_name: string;
  bates: boolean;
  replace_existing: boolean;
};

// The argument of marks.header_footer. Bates fields are sent only in Bates mode, so the engine's
// defaults apply to header & footer. The color must already be valid (see canRunHeaderFooter).
export function headerFooterArgs(
  form: HeaderFooterForm,
  pages: readonly number[],
  fileName: string,
  bates: boolean,
  replace: boolean,
): HeaderFooterArgs {
  const color = hexToColor(form.color) ?? { r: 0, g: 0, b: 0 };
  const spec: HeaderFooterArgs['spec'] = {
    texts: nonEmptyTexts(form.texts),
    font: form.font,
    font_size: form.fontSize,
    color,
    margin_x: form.marginX,
    margin_top: form.marginTop,
    margin_bottom: form.marginBottom,
  };
  if (bates) {
    spec.bates_prefix = form.bates.prefix;
    spec.bates_start = form.bates.start;
    spec.bates_digits = form.bates.digits;
    spec.bates_suffix = form.bates.suffix;
  }
  return { spec, pages, file_name: fileName, bates, replace_existing: replace };
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
// a font size outside 4 to 72, a colour that is not #rrggbb, Bates digits outside 1 to 15, a
// negative start, or a margin that is negative or not a number.
export function canRunHeaderFooter(form: HeaderFooterForm, pages: readonly number[]): boolean {
  if (pages.length === 0) return false;
  if (Object.keys(nonEmptyTexts(form.texts)).length === 0) return false;
  if (!isFiniteIn(form.fontSize, 4, 72)) return false;
  if (hexToColor(form.color) === undefined) return false;
  for (const margin of [form.marginX, form.marginTop, form.marginBottom]) {
    if (!Number.isFinite(margin) || margin < 0) return false;
  }
  if (!Number.isInteger(form.bates.digits) || !isFiniteIn(form.bates.digits, 1, 15)) return false;
  return Number.isInteger(form.bates.start) && form.bates.start >= 0;
}

// Whether the watermark form can run: text that is not blank, pages, a valid colour, and an
// opacity from 0 to 1.
export function canRunWatermark(form: WatermarkForm, pages: readonly number[]): boolean {
  if (pages.length === 0) return false;
  if (form.text.trim() === '') return false;
  if (hexToColor(form.color) === undefined) return false;
  return isFiniteIn(form.opacity, 0, 1);
}

// Whether the background colour can run: pages, a valid colour, and an opacity from 0 to 1.
export function canRunBackground(hex: string, opacity: number, pages: readonly number[]): boolean {
  return pages.length > 0 && hexToColor(hex) !== undefined && isFiniteIn(opacity, 0, 1);
}

// The kinds of mark the document already has, with how many pages carry each. Read before the
// dialog is shown, so Replace and Remove appear only when there is something to act on.
export async function listMarks(rpc: PageRpc, handle: string): Promise<readonly MarkSummaryDto[]> {
  const reply = await rpc.call('marks.list', { handle });
  return reply.items;
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
