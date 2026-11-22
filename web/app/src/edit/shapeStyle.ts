// The style of the shapes drawn next (W6.7b slice 3a): one outline, one optional fill and one line
// width for all three shape tools, as the desktop's text tool keeps one style for its boxes. It is
// session state only: a change touches no document and is not an undo step, and a shape already on
// the page keeps its style. The defaults are the style every web shape had before (black, 1.5 pt).
import { colorInputValue } from '../redaction/MarkStyleFields';
import type { ColorJson } from '../prefs/colour';
import { t } from '../i18n/t';

// The widest outline a shape may have, in points. The engine refuses more (MAX_SHAPE_WIDTH).
export const MAX_SHAPE_WIDTH = 72;

export interface ShapeStyle {
  readonly outline: ColorJson;
  // null for no fill. A line never has one, whatever is set here.
  readonly fill: ColorJson | null;
  readonly width: number;
}

export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  outline: { r: 0, g: 0, b: 0 },
  fill: null,
  width: 1.5,
};

// The colour and width fields of a ShapeSpec, as the engine takes them: alpha is always 1.
export interface ShapePaint {
  readonly stroke: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly fill: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  } | null;
  readonly width: number;
}

let current: ShapeStyle = DEFAULT_SHAPE_STYLE;
const listeners = new Set<() => void>();

export function currentShapeStyle(): ShapeStyle {
  return current;
}

export function setShapeStyle(style: ShapeStyle): void {
  current = style;
  for (const listener of listeners) listener();
}

// For useSyncExternalStore: the listener runs after each change.
export function subscribeShapeStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The paint a shape drawn now carries, in the engine's form.
export function paintOf(style: ShapeStyle): ShapePaint {
  return {
    stroke: { ...style.outline, a: 1 },
    fill: style.fill === null ? null : { ...style.fill, a: 1 },
    width: style.width,
  };
}

// The width the dialog's text field gives: a number above 0 and at most MAX_SHAPE_WIDTH, or null.
// Empty text, words and a number out of range are all null, so OK stays disabled.
export function parseShapeWidth(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_SHAPE_WIDTH) return null;
  return value;
}

// What a shape looks like in words, for the screen reader (ShapeLayer's aria-describedby). The
// colour is given as its hex value; naming colours is not attempted.
export function shapeStyleSummary(style: ShapeStyle): string {
  return t('edit.shape.styleSummary', {
    outline: colorInputValue(style.outline),
    width: String(style.width),
    fill:
      style.fill === null
        ? t('edit.shape.noFill')
        : t('edit.shape.filled', { colour: colorInputValue(style.fill) }),
  });
}
