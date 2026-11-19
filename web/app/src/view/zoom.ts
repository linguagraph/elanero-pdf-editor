// Zoom values and the device scale of a render (W1.4 sections 1, 3 and 12). The steps and limits
// are the desktop's (src/pdfeditor/ui/view/document_view.py: MIN_ZOOM, MAX_ZOOM, ZOOM_STEPS), copied
// here as constants; a change on the desktop should be mirrored here.
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 64;
export const ZOOM_STEPS: readonly number[] = [
  0.1, 0.25, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 32, 64,
];

// The desktop's default zoom: 1.0 is the page at physical size.
export const DEFAULT_ZOOM = 1;

// A CSS pixel is 1/96 inch and a point is 1/72 inch, so 1 pt is 96/72 CSS px at zoom 1.
export const CSS_PX_PER_POINT = 96 / 72;

// The step after (direction 1) or before (direction -1) the zoom, or the zoom clamped when no
// step lies that way. Steps are the desktop's, so the buttons move through the same values.
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) {
    const next = ZOOM_STEPS.find((step) => step > zoom + 1e-9);
    return clampZoom(next ?? MAX_ZOOM);
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    const step = ZOOM_STEPS[i] ?? MIN_ZOOM;
    if (step < zoom - 1e-9) return clampZoom(step);
  }
  return MIN_ZOOM;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// Python's round(): halves go to the even neighbour. Matters for the quantized scale, so the port
// rounds the same way as the desktop's cache keys.
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

// The device scale of a render, snapped to ~2 % steps and given in thousandths (W1.4 section 3,
// the port of core/render_cache.quantize_scale). The raw scale is zoom x 96/72 x devicePixelRatio.
export function quantizeScale(scale: number): number {
  if (!(scale > 0)) throw new RangeError('scale must be positive');
  const step = 1.02;
  const n = roundHalfEven(Math.log(scale) / Math.log(step));
  return Math.max(1, roundHalfEven(1000 * step ** n));
}

// The largest scale_milli the engine renders (webapi/limits.py MAX_RENDER_SCALE_MILLI, device
// scale 256). Above it render.page refuses with RENDER_TOO_LARGE, so the viewer clamps first:
// zoom 64 on a DPR 4 screen would otherwise show a blank page. Mirror any change on the engine side.
export const MAX_RENDER_SCALE_MILLI = 256_000;

// scale_milli for render.page: zoom x 96/72 x devicePixelRatio, quantized (W1.4 section 3) and
// clamped to MAX_RENDER_SCALE_MILLI.
export function scaleMilli(zoom: number, devicePixelRatio: number): number {
  return Math.min(
    MAX_RENDER_SCALE_MILLI,
    quantizeScale(zoom * CSS_PX_PER_POINT * devicePixelRatio),
  );
}
