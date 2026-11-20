// The crop box drawn on a page (W4.11 S5): a drag from one pointer offset to another, in the page's
// visible space. Pure, so the layer and its tests share one rule. The offsets are CSS pixels from
// the page box's top-left corner, as the layer reads them.
import { pagePointAt, rectBetween, type PageRect } from '../comments/coordinates';

// A box thinner than this in either direction is a click or a stray drag, not a box.
export const MIN_CROP_BOX_PT = 4;

export function cropBoxRect(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  zoom: number,
  widthPt: number,
  heightPt: number,
): PageRect | null {
  const box = rectBetween(
    pagePointAt(start.x, start.y, zoom, widthPt, heightPt),
    pagePointAt(end.x, end.y, zoom, widthPt, heightPt),
  );
  if (box.x1 - box.x0 < MIN_CROP_BOX_PT || box.y1 - box.y0 < MIN_CROP_BOX_PT) return null;
  return box;
}
