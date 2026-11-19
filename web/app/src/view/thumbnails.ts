// Thumbnail geometry and scale (W1.4 section 9, W5.2). A thumbnail is the whole page at 160 CSS px
// wide, times the device pixel ratio: the desktop's THUMBNAIL_WIDTH_PX. Pure arithmetic, so the
// lazy window and the scale are tested without a browser.
import { type PageBox, type PageSizePt, visibleRange } from './layout';
import { quantizeScale } from './zoom';

export const THUMBNAIL_WIDTH_CSS_PX = 160;

// The gap between two thumbnails, in CSS pixels.
export const THUMBNAIL_GAP_CSS_PX = 12;

export interface ThumbnailSize extends PageSizePt {
  // The page's /Rotate. session.pages reports width and height already in the visible space, so
  // the rotation is not applied again here; it is kept so the caller passes the reply's sizes whole.
  readonly rotation: number;
}

// scale_milli for render.page: device pixels per point that make the visible page exactly
// THUMBNAIL_WIDTH_CSS_PX x devicePixelRatio wide, quantized the same way as the page renders.
export function thumbnailScaleMilli(size: ThumbnailSize, devicePixelRatio: number): number {
  return quantizeScale((THUMBNAIL_WIDTH_CSS_PX * devicePixelRatio) / size.width);
}

// The thumbnail box of every page, stacked top to bottom in the panel, in CSS pixels. The boxes do
// not depend on the document's zoom.
export function thumbnailBoxes(sizes: readonly ThumbnailSize[]): {
  readonly boxes: PageBox[];
  readonly height: number;
} {
  const boxes: PageBox[] = [];
  let top = THUMBNAIL_GAP_CSS_PX;
  sizes.forEach((size, index) => {
    const height = (size.height / size.width) * THUMBNAIL_WIDTH_CSS_PX;
    boxes.push({ index, top, left: THUMBNAIL_GAP_CSS_PX, width: THUMBNAIL_WIDTH_CSS_PX, height });
    top += height + THUMBNAIL_GAP_CSS_PX;
  });
  return { boxes, height: sizes.length === 0 ? 0 : top };
}

// The thumbnails to request: those near the panel's viewport, one viewport above and below, the
// same window the document view keeps mounted. Half-open range of indexes.
export function thumbnailWindow(
  boxes: readonly PageBox[],
  scrollTop: number,
  viewportHeight: number,
): { first: number; end: number } {
  return visibleRange(boxes, scrollTop, viewportHeight);
}
