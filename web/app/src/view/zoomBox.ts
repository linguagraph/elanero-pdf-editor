// The zoom box of the canvas pill (W4.2a S5, W1.6 section 4): the presets its list offers and the
// reading of a typed zoom. The presets are the desktop's (ui/view/pill.py ZoomBox.PRESETS).
import { clampZoom } from './zoom';

export const ZOOM_PRESETS: readonly ('fitWidth' | 'fitPage' | number)[] = [
  'fitWidth',
  'fitPage',
  0.5,
  0.75,
  1,
  1.25,
  1.5,
  2,
  4,
];

// What the zoom box asks for: a fit mode, or a manual zoom (already clamped to the zoom limits).
export type ZoomRequest = { readonly fit: 'width' | 'page' } | { readonly zoom: number };

// The English labels of the fit presets, matched without case. The list shows the translated
// labels; a typed fit name is read in English, as the desktop's box does.
const FIT_NAMES: Readonly<Record<string, ZoomRequest>> = {
  'fit width': { fit: 'width' },
  'fit page': { fit: 'page' },
};

// A typed zoom: a number with an optional percent sign ("150", "150%", " 150 % "), or a fit name.
// Anything else is null. The number is a percentage, so 150 is 1.5, and it is clamped to the
// zoom limits (5000 becomes 64, 0 becomes 0.05).
export function parseZoomInput(text: string): ZoomRequest | null {
  const trimmed = text.trim();
  const fit = FIT_NAMES[trimmed.toLowerCase()];
  if (fit !== undefined) return fit;
  const match = /^(\d+(?:\.\d+)?)\s*%?$/.exec(trimmed);
  if (match === null) return null;
  const percent = Number(match[1]);
  return { zoom: clampZoom(percent / 100) };
}
