// The gesture layer over one page while a comment tool is on (W7.1a, W1.5 section 6). A click
// places a sticky note, which then asks for its text; a drag draws the box of a rectangle or a
// highlight. The layer only reports the page points it worked out; the engine builds the comment.
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
import { type CommentToolId, isDragTool } from './tools';
import './comments.css';

// A drag shorter than this (page points) is a click, not a box.
const MIN_DRAG_PT = 2;

export interface CommentLayerProps {
  readonly tool: CommentToolId;
  // The page's zoom and size in points: the mapping from pointer offsets to page points.
  readonly zoom: number;
  readonly widthPt: number;
  readonly heightPt: number;
  // The box the user drew, or for a note the point it sits at (x0, y0), and the note's text.
  readonly onPlace: (rect: PageRect, text: string) => void;
}

export function CommentLayer({ tool, zoom, widthPt, heightPt, onPlace }: CommentLayerProps) {
  const [start, setStart] = useState<PagePoint | null>(null);
  const [current, setCurrent] = useState<PagePoint | null>(null);
  const [notePoint, setNotePoint] = useState<PagePoint | null>(null);
  const [noteText, setNoteText] = useState('');

  // The pointer offset is taken from the layer, which covers exactly the page box.
  const pointOf = (event: PointerEvent<HTMLDivElement>): PagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return pagePointAt(event.clientX - box.left, event.clientY - box.top, zoom, widthPt, heightPt);
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || notePoint !== null) return;
    const point = pointOf(event);
    if (!isDragTool(tool)) {
      setNotePoint(point);
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
    const box = rectBetween(start, pointOf(event));
    setStart(null);
    setCurrent(null);
    if (box.x1 - box.x0 < MIN_DRAG_PT && box.y1 - box.y0 < MIN_DRAG_PT) return;
    onPlace(box, '');
  };

  const submitNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (notePoint === null || noteText.trim() === '') return;
    const at = { x0: notePoint.x, y0: notePoint.y, x1: notePoint.x, y1: notePoint.y };
    setNotePoint(null);
    onPlace(at, noteText);
  };

  return (
    <div
      className="comment-layer"
      role="presentation"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={finish}
    >
      {start !== null && current !== null ? (
        <div className="comment-preview" style={cssBox(rectBetween(start, current), zoom)} />
      ) : null}
      {notePoint !== null ? (
        <form
          className="comment-note-form"
          style={{ left: pointsToCss(notePoint.x, zoom), top: pointsToCss(notePoint.y, zoom) }}
          onSubmit={submitNote}
        >
          <textarea
            aria-label={t('comment.noteText')}
            rows={3}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            autoFocus
          />
          <div className="comment-note-actions">
            <button type="submit" disabled={noteText.trim() === ''}>
              {t('comment.noteAdd')}
            </button>
            <button type="button" onClick={() => setNotePoint(null)}>
              {t('comment.cancel')}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
