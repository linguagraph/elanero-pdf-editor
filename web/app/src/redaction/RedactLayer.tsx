// The gesture layer over one page while the mark tool is on (W7.4, W1.5 section 6). A drag draws
// the box of a redaction mark; the layer reports the page box and leaves the engine to build the
// mark. A click, or a drag too small to be a box, marks nothing.
import { type PointerEvent, useState } from 'react';
import { cssBox, type PageRect } from '../comments/coordinates';
import { redactionRect } from './marks';
import './redaction.css';

export interface RedactLayerProps {
  // The page's zoom and size in points: the mapping from pointer offsets to page points.
  readonly zoom: number;
  readonly widthPt: number;
  readonly heightPt: number;
  readonly onPlace: (rect: PageRect) => void;
}

interface Offset {
  readonly x: number;
  readonly y: number;
}

export function RedactLayer({ zoom, widthPt, heightPt, onPlace }: RedactLayerProps) {
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
    const rect = redactionRect(start, offsetOf(event), zoom, widthPt, heightPt);
    setStart(null);
    setCurrent(null);
    if (rect !== null) onPlace(rect);
  };

  const preview =
    start !== null && current !== null
      ? redactionRect(start, current, zoom, widthPt, heightPt)
      : null;

  return (
    <div
      className="redact-layer"
      role="presentation"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={finish}
    >
      {preview !== null ? <div className="redact-preview" style={cssBox(preview, zoom)} /> : null}
    </div>
  );
}

// The outline of the marks selected in the Redactions panel, drawn on their page (W7.4b S4). It
// shows whether or not the mark tool is on, and takes no pointer events, so it never blocks a drag.
export function SelectedMarkOutlines({
  rects,
  zoom,
}: {
  readonly rects: readonly PageRect[];
  readonly zoom: number;
}) {
  return (
    <>
      {rects.map((rect, index) => (
        <div key={index} className="redact-selected" style={cssBox(rect, zoom)} />
      ))}
    </>
  );
}
