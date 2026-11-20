// The gesture layer over one page while the crop box tool is on (W4.11 S5). A drag draws the box;
// the layer reports its page rectangle in points and the view turns it into margins. A click, or a
// drag too small to be a box, draws nothing. It copies the redaction layer's gesture (RedactLayer).
import { type PointerEvent, useState } from 'react';
import { cssBox, type PageRect } from '../comments/coordinates';
import { cropBoxRect } from './cropBox';
import './crop.css';

export interface CropLayerProps {
  // The page's zoom and size in points: the mapping from pointer offsets to page points.
  readonly zoom: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly onDraw: (rect: PageRect) => void;
}

interface Offset {
  readonly x: number;
  readonly y: number;
}

export function CropLayer({ zoom, widthPt, heightPt, onDraw }: CropLayerProps) {
  const [start, setStart] = useState<Offset | null>(null);
  const [current, setCurrent] = useState<Offset | null>(null);

  // The offset is taken from the layer, which covers exactly the page box.
  const offsetOf = (event: PointerEvent<HTMLDivElement>): Offset => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = offsetOf(event);
    setStart(at);
    setCurrent(at);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start !== null) setCurrent(offsetOf(event));
  };

  // Ends the drag on release, or when the pointer leaves the page (the box then stops at the edge).
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (start === null) return;
    const rect = cropBoxRect(start, offsetOf(event), zoom, widthPt, heightPt);
    setStart(null);
    setCurrent(null);
    if (rect !== null) onDraw(rect);
  };

  const preview =
    start !== null && current !== null
      ? cropBoxRect(start, current, zoom, widthPt, heightPt)
      : null;

  return (
    <div
      className="crop-layer"
      role="presentation"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={finish}
    >
      {preview !== null ? <div className="crop-preview" style={cssBox(preview, zoom)} /> : null}
    </div>
  );
}
