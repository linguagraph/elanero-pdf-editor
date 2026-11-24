// The gesture layer over one page while a comment tool is on (W7.1a, W1.5 section 6). A click
// places a sticky note, and a text box is a drag or a click; each then asks for its text. A drag
// draws the box of a rectangle, oval or highlight, and a drag between two ends draws a line or
// arrow. A callout takes its tip on a click, then its box. A pen draws a stroke while dragged, and
// a polygon or polyline collects a click per vertex until a double-click (or Enter) finishes it.
// The layer only reports the page points it worked out; the engine builds the comment.
import { type FormEvent, type PointerEvent, useEffect, useState } from 'react';
import { t } from '../i18n/t';
import {
  cssBox,
  type PagePoint,
  type PageRect,
  pagePointAt,
  pointsToCss,
  rectBetween,
} from './coordinates';
import {
  appendStrokePoint,
  boundsOf,
  calloutLine,
  defaultCalloutBox,
  distance,
  POLYGON_CLOSE_PT,
  polyVertices,
} from './pointGeometry';
import { type CommentToolId, GESTURE_KIND } from './tools';
import './comments.css';

// A drag shorter than this (page points) is a click, not a box.
const MIN_DRAG_PT = 2;

// The controls a keypress can belong to, so Enter in one of them is not taken as a gesture's end.
const CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON']);

function isControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && CONTROL_TAGS.has(target.tagName);
}

// The zero-area box at a point: a note's icon corner, or a text box drawn as a click.
function pointRect(point: PagePoint): PageRect {
  return { x0: point.x, y0: point.y, x1: point.x, y1: point.y };
}

export interface CommentLayerProps {
  readonly tool: CommentToolId;
  // The page's zoom and size in points: the mapping from pointer offsets to page points.
  readonly zoom: number;
  readonly widthPt: number;
  readonly heightPt: number;
  // The gesture's box (a zero-area box at the point for a click), the text (empty for a
  // gesture without one), and the page points of the gesture: a line's or arrow's two ends, a
  // callout's tip, a pen's stroke, or a polygon's or polyline's vertices (empty otherwise).
  readonly onPlace: (rect: PageRect, text: string, points: readonly PagePoint[]) => void;
}

// Places a polygon or polyline with its vertices, when enough of them are distinct.
function placePoly(
  tool: CommentToolId,
  vertices: readonly PagePoint[],
  onPlace: CommentLayerProps['onPlace'],
): void {
  const points = polyVertices(tool, vertices);
  if (points !== null) onPlace(boundsOf(points), '', points);
}

export function CommentLayer({ tool, zoom, widthPt, heightPt, onPlace }: CommentLayerProps) {
  const [start, setStart] = useState<PagePoint | null>(null);
  const [current, setCurrent] = useState<PagePoint | null>(null);
  // The text form that is open, with the box its text will go in.
  const [pending, setPending] = useState<PageRect | null>(null);
  const [noteText, setNoteText] = useState('');
  // A callout's tip, once clicked, until its box is drawn; and the tip of the open callout form.
  const [tip, setTip] = useState<PagePoint | null>(null);
  const [pendingTip, setPendingTip] = useState<PagePoint | null>(null);
  // A pen stroke in progress, or the vertices of a polygon or polyline so far.
  const [path, setPath] = useState<PagePoint[]>([]);
  const kind = GESTURE_KIND[tool];
  // A polygon or polyline with vertices, a callout with its tip, or a drag or stroke that is down.
  const gestureActive = (kind === 'poly' && path.length > 0) || tip !== null || start !== null;

  // Enter finishes a polygon or polyline in progress, as the desktop's PolyTool does. A key that
  // came from a control (a form field or a button) keeps its own meaning, and so does one another
  // handler has already taken.
  useEffect(() => {
    if (kind !== 'poly' || path.length === 0) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      if (isControl(event.target)) return;
      event.preventDefault();
      placePoly(tool, path, onPlace);
      setPath([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind, tool, path, onPlace]);

  // Escape cancels a gesture in progress. With nothing in progress it is left alone, so the
  // toolbar and the rest of the page keep their own Escape handling.
  useEffect(() => {
    if (!gestureActive) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setPath([]);
      setTip(null);
      setStart(null);
      setCurrent(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gestureActive]);

  // The pointer offset is taken from the layer, which covers exactly the page box.
  const pointOf = (event: PointerEvent<HTMLDivElement>): PagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return pagePointAt(event.clientX - box.left, event.clientY - box.top, zoom, widthPt, heightPt);
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || pending !== null) return;
    const point = pointOf(event);
    if (kind === 'click') {
      setPending(pointRect(point));
      setNoteText('');
      return;
    }
    if (kind === 'poly') {
      // A click on the first vertex closes a polygon; any other click adds a vertex.
      const first = path[0];
      if (tool === 'polygon' && path.length >= 2 && first !== undefined) {
        if (distance(point, first) <= POLYGON_CLOSE_PT) {
          placePoly(tool, path, onPlace);
          setPath([]);
          return;
        }
      }
      setPath((prev) => [...prev, point]);
      return;
    }
    if (kind === 'stroke') {
      setStart(point);
      setPath([point]);
      return;
    }
    if (kind === 'callout' && tip === null) {
      setTip(point);
      return;
    }
    setStart(point);
    setCurrent(point);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start === null) return;
    // The point is read now: the event's target is gone by the time a state updater runs.
    const point = pointOf(event);
    if (kind === 'stroke') setPath((prev) => appendStrokePoint(prev, point));
    else setCurrent(point);
  };

  // Ends a drag on release, or when the pointer leaves the page (the box then stops at the edge).
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (kind === 'poly') return;
    if (kind === 'stroke') {
      if (start === null) return;
      setStart(null);
      if (path.length >= 2) onPlace(boundsOf(path), '', path);
      setPath([]);
      return;
    }
    if (start === null) return;
    const end = pointOf(event);
    const box = rectBetween(start, end);
    setStart(null);
    setCurrent(null);
    const drag = box.x1 - box.x0 >= MIN_DRAG_PT || box.y1 - box.y0 >= MIN_DRAG_PT;
    if (kind === 'callout') {
      if (tip === null) return;
      // A click gives the engine's default box, on the side of the tip away from the click.
      setPending(drag ? box : defaultCalloutBox(tip, start));
      setPendingTip(tip);
      setTip(null);
      setNoteText('');
      return;
    }
    if (kind === 'text') {
      // A click gives the engine's default size, from the point clicked.
      setPending(drag ? box : pointRect(start));
      setNoteText('');
      return;
    }
    if (!drag) return;
    onPlace(box, '', kind === 'line' ? [start, end] : []);
  };

  const onDoubleClick = () => {
    if (kind !== 'poly') return;
    placePoly(tool, path, onPlace);
    setPath([]);
  };

  const submitNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending === null || noteText.trim() === '') return;
    const rect = pending;
    const points = pendingTip === null ? [] : [pendingTip];
    setPending(null);
    setPendingTip(null);
    onPlace(rect, noteText, points);
  };

  const cancelNote = () => {
    setPending(null);
    setPendingTip(null);
  };

  const isNote = kind === 'click';
  const isCallout = kind === 'callout';
  const showBox =
    start !== null && current !== null && (kind === 'box' || kind === 'text' || isCallout);
  // The line, leader or stroke or polygon outline drawn over the page, in page points.
  let guide: readonly PagePoint[] = [];
  if (kind === 'line' && start !== null && current !== null) {
    guide = [start, current];
  } else if (isCallout && tip !== null && start !== null && current !== null) {
    guide = calloutLine(tip, rectBetween(start, current));
  } else if (isCallout && pendingTip !== null && pending !== null) {
    guide = calloutLine(pendingTip, pending);
  } else if (kind === 'stroke' || kind === 'poly') {
    guide = path;
  }
  return (
    <div
      className="comment-layer"
      role="presentation"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={finish}
      onDoubleClick={onDoubleClick}
    >
      {showBox && start !== null && current !== null ? (
        <div
          className={tool === 'oval' ? 'comment-preview comment-preview-oval' : 'comment-preview'}
          style={cssBox(rectBetween(start, current), zoom)}
        />
      ) : null}
      {guide.length >= 2 ? (
        <svg
          className="comment-line-preview"
          viewBox={`0 0 ${widthPt} ${heightPt}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          {kind === 'line' ? (
            <line x1={guide[0]?.x} y1={guide[0]?.y} x2={guide[1]?.x} y2={guide[1]?.y} />
          ) : (
            <polyline points={guide.map((p) => `${p.x},${p.y}`).join(' ')} />
          )}
        </svg>
      ) : null}
      {tip !== null ? (
        <div
          className="comment-tip"
          style={{ left: pointsToCss(tip.x, zoom), top: pointsToCss(tip.y, zoom) }}
        />
      ) : null}
      {pending !== null && pending.x1 > pending.x0 && pending.y1 > pending.y0 ? (
        <div className="comment-preview" style={cssBox(pending, zoom)} />
      ) : null}
      {pending !== null ? (
        <form
          className="comment-note-form"
          style={{ left: pointsToCss(pending.x0, zoom), top: pointsToCss(pending.y0, zoom) }}
          onSubmit={submitNote}
        >
          <textarea
            aria-label={
              isNote
                ? t('comment.noteText')
                : isCallout
                  ? t('comment.calloutText')
                  : t('comment.boxText')
            }
            rows={3}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            autoFocus
          />
          <div className="comment-note-actions">
            <button type="submit" disabled={noteText.trim() === ''}>
              {isNote
                ? t('comment.noteAdd')
                : isCallout
                  ? t('comment.calloutAdd')
                  : t('comment.boxAdd')}
            </button>
            <button type="button" onClick={cancelNote}>
              {t('comment.cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
