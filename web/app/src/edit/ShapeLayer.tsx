// The gesture layer over one page while a shape tool is on (W6.7b). A drag draws the box or the
// segment of the shape, a click draws the default size from the press point, and Enter places a
// default-size shape in the middle of the page. The layer only reports the spec it worked out; the
// engine adds the shape (edit/shapes.ts).
import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useState,
  useSyncExternalStore,
} from 'react';
import { cssBox, type PagePoint, pagePointAt, pointsToCss } from '../comments/coordinates';
import { t } from '../i18n/t';
import {
  centredGesture,
  type PageSize,
  type PlacedKind,
  type ShapeSpec,
  shapeGesture,
} from './shapes';
import { currentShapeStyle, shapeStyleSummary, subscribeShapeStyle } from './shapeStyle';
import './edit.css';

export interface ShapeLayerProps {
  // A shape, or 'image' for the box an image is placed in (its own label and dashed preview).
  readonly kind: PlacedKind;
  // The page's zoom and size in points: the mapping from pointer offsets to page points.
  readonly zoom: number;
  readonly widthPt: number;
  readonly heightPt: number;
  // Only the current page's layer takes the keyboard; the others stay out of the tab order.
  readonly focusable: boolean;
  // A finished gesture: the shape to add, or null when it would draw nothing.
  readonly onDraw: (spec: ShapeSpec | null) => void;
  // Escape with nothing being dragged: the tool is turned off.
  readonly onStop: () => void;
}

// The preview's class: an ellipse is round, an image box is dashed, a rectangle is solid.
function previewClass(kind: PlacedKind): string {
  if (kind === 'ellipse') return 'shape-preview shape-preview--ellipse';
  if (kind === 'image') return 'shape-preview shape-preview--image';
  return 'shape-preview';
}

export function ShapeLayer({
  kind,
  zoom,
  widthPt,
  heightPt,
  focusable,
  onDraw,
  onStop,
}: ShapeLayerProps) {
  const [start, setStart] = useState<PagePoint | null>(null);
  const [current, setCurrent] = useState<PagePoint | null>(null);
  const page: PageSize = { widthPt, heightPt };
  // The style the next shape takes, said in words for the screen reader (the layer is focused
  // while a shape tool is on, so Enter draws in this style).
  const styleId = useId();
  const style = useSyncExternalStore(subscribeShapeStyle, currentShapeStyle);

  // The pointer offset is taken from the layer, which covers exactly the page box.
  const pointOf = (event: PointerEvent<HTMLDivElement>): PagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return pagePointAt(event.clientX - box.left, event.clientY - box.top, zoom, widthPt, heightPt);
  };

  // The pointer is captured, so a drag that leaves the page keeps tracking (the comment layer
  // ends its drag on pointerleave instead, which would cut a shape short).
  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    const point = pointOf(event);
    setStart(point);
    setCurrent(point);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start !== null) setCurrent(pointOf(event));
  };

  const onUp = (event: PointerEvent<HTMLDivElement>) => {
    if (start === null) return;
    const end = pointOf(event);
    setStart(null);
    setCurrent(null);
    onDraw(shapeGesture(kind, start, end, page));
  };

  // A cancelled pointer (the browser took it) draws nothing.
  const onCancel = () => {
    setStart(null);
    setCurrent(null);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (start !== null) {
        setStart(null);
        setCurrent(null);
      } else {
        onStop();
      }
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && start === null) {
      event.preventDefault();
      onDraw(centredGesture(kind, page));
    }
  };

  const preview =
    start !== null && current !== null ? shapeGesture(kind, start, current, page) : null;

  return (
    <div
      className="shape-layer"
      role="application"
      aria-label={kind === 'image' ? t('edit.image.layer') : t('edit.shape.layer')}
      tabIndex={focusable ? 0 : -1}
      aria-describedby={styleId}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onKeyDown={onKey}
    >
      <span id={styleId} hidden>
        {shapeStyleSummary(style)}
      </span>
      {preview?.rect !== undefined ? (
        <div className={previewClass(kind)} style={cssBox(preview.rect, zoom)} />
      ) : null}
      {preview?.start !== undefined && preview.end !== undefined ? (
        <svg className="shape-line-preview" aria-hidden="true">
          <line
            x1={pointsToCss(preview.start.x, zoom)}
            y1={pointsToCss(preview.start.y, zoom)}
            x2={pointsToCss(preview.end.x, zoom)}
            y2={pointsToCss(preview.end.y, zoom)}
          />
        </svg>
      ) : null}
    </div>
  );
}
