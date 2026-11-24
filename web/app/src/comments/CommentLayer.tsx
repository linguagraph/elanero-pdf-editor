// The gesture layer over one page while a comment tool is on (W7.1a, W1.5 section 6). A click
// places a sticky note, and a text box is a drag or a click; each then asks for its text. A drag
// draws the box of a rectangle, oval or highlight, and a drag between two ends draws a line or
// arrow. The layer only reports the page points it worked out; the engine builds the comment.
import { type FormEvent, type PointerEvent, useState } from 'react';
import { t } from '../i18n/t';
import {
  cssBox,
  type PagePoint,
  type PageRect,
  pagePointAt,
  pointsToCss,
  rectBetween,
} from './coordinates';
import { type CommentToolId, GESTURE_KIND } from './tools';
import './comments.css';

// A drag shorter than this (page points) is a click, not a box.
const MIN_DRAG_PT = 2;

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
  // gesture without one), and for a line or arrow its two ends (empty otherwise).
  readonly onPlace: (rect: PageRect, text: string, points: readonly PagePoint[]) => void;
}

export function CommentLayer({ tool, zoom, widthPt, heightPt, onPlace }: CommentLayerProps) {
  const [start, setStart] = useState<PagePoint | null>(null);
  const [current, setCurrent] = useState<PagePoint | null>(null);
  // The text form that is open, with the box its text will go in.
  const [pending, setPending] = useState<PageRect | null>(null);
  const [noteText, setNoteText] = useState('');
  const kind = GESTURE_KIND[tool];

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
    setStart(point);
    setCurrent(point);
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start !== null) setCurrent(pointOf(event));
  };

  // Ends a drag on release, or when the pointer leaves the page (the box then stops at the edge).
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (start === null) return;
    const end = pointOf(event);
    const box = rectBetween(start, end);
    setStart(null);
    setCurrent(null);
    const drag = box.x1 - box.x0 >= MIN_DRAG_PT || box.y1 - box.y0 >= MIN_DRAG_PT;
    if (kind === 'text') {
      // A click gives the engine's default size, from the point clicked.
      setPending(drag ? box : pointRect(start));
      setNoteText('');
      return;
    }
    if (!drag) return;
    onPlace(box, '', kind === 'line' ? [start, end] : []);
  };

  const submitNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending === null || noteText.trim() === '') return;
    const rect = pending;
    setPending(null);
    onPlace(rect, noteText, []);
  };

  const isNote = kind === 'click';
  const showBox = start !== null && current !== null && kind !== 'line';
  const showLine = start !== null && current !== null && kind === 'line';
  return (
    <div
      className="comment-layer"
      role="presentation"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={finish}
    >
      {showBox && start !== null && current !== null ? (
        <div
          className={tool === 'oval' ? 'comment-preview comment-preview-oval' : 'comment-preview'}
          style={cssBox(rectBetween(start, current), zoom)}
        />
      ) : null}
      {showLine && start !== null && current !== null ? (
        <svg
          className="comment-line-preview"
          viewBox={`0 0 ${widthPt} ${heightPt}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <line x1={start.x} y1={start.y} x2={current.x} y2={current.y} />
        </svg>
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
            aria-label={isNote ? t('comment.noteText') : t('comment.boxText')}
            rows={3}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            autoFocus
          />
          <div className="comment-note-actions">
            <button type="submit" disabled={noteText.trim() === ''}>
              {isNote ? t('comment.noteAdd') : t('comment.boxAdd')}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              {t('comment.cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
