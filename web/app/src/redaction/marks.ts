// The redaction marks the web draws and sends (W7.4). A drag on a page is mapped to a box in page
// points at the zoom (the same mapping as the comment tools, W1.5 section 6); the engine builds the
// mark. Page points are visible space with the origin top-left, as the engine expects (W1.3).
import { type PagePoint, type PageRect, pagePointAt, rectBetween } from '../comments/coordinates';
import type { ColorJson } from '../prefs/colour';

// A drag shorter than this (page points) is a click, not a box.
export const MIN_MARK_PT = 2;

// A mark the engine named: its page and its /NM name (W1.3 MarkRef, never an object id).
export interface MarkRef {
  readonly page: number;
  readonly name: string;
}

// The redaction options the apply sends. These are the desktop's defaults (RedactOptions).
export interface RedactOptionsJson {
  readonly images: 'none' | 'pixels' | 'remove';
  readonly graphics: 'none' | 'covered' | 'touched';
  readonly text: boolean;
}

export const DEFAULT_REDACT_OPTIONS: RedactOptionsJson = {
  images: 'pixels',
  graphics: 'covered',
  text: true,
};

// The box a drag from one pointer offset to another marks, in page points. The offsets are CSS
// pixels from the page box's top-left corner, as the layer reads them. Null for a click or a drag
// too small to be a box.
export function redactionRect(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  zoom: number,
  widthPt: number,
  heightPt: number,
): PageRect | null {
  const a: PagePoint = pagePointAt(start.x, start.y, zoom, widthPt, heightPt);
  const b: PagePoint = pagePointAt(end.x, end.y, zoom, widthPt, heightPt);
  const box = rectBetween(a, b);
  if (box.x1 - box.x0 < MIN_MARK_PT && box.y1 - box.y0 < MIN_MARK_PT) return null;
  return box;
}

// The RedactionArea a mark is made from, as RedactionArea in model/redaction.py takes it. A plain
// box: the text runs under it are found by the engine when the mark is applied.
export function redactionAreaJson(
  page: number,
  rect: PageRect,
): { page: number; rect: { x0: number; y0: number; x1: number; y1: number } } {
  return { page, rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 } };
}

// The job's marks as the apply takes them: each named by its page and name.
export function markRefsJson(marks: readonly MarkRef[]): { page: number; name: string }[] {
  return marks.map((mark) => ({ page: mark.page, name: mark.name }));
}

// A change to some of a mark's style (W7.4b). A field left out is not changed; "" clears the
// overlay text.
export interface MarkStylePatch {
  readonly fill?: ColorJson;
  readonly overlayText?: string;
  readonly textColor?: ColorJson;
}

// The patch as redaction.restyle_marks takes it: only the fields the patch sets.
export function markStylePatchJson(patch: MarkStylePatch): Record<string, unknown> {
  const json: Record<string, unknown> = {};
  if (patch.fill !== undefined) json.fill = patch.fill;
  if (patch.overlayText !== undefined) json.overlay_text = patch.overlayText;
  if (patch.textColor !== undefined) json.text_color = patch.textColor;
  return json;
}
