// The Select tool's comment selection over one page (W7.1a slices 6 and 7). The layer draws an
// outline around each selected comment and selects by press: a press on a comment selects it (Ctrl
// or Cmd toggles it), a press on empty page clears the selection, and Escape clears it. A press on a
// selected movable comment starts a move of the selected comments on this page; a press on a handle
// of the one selected resizable comment starts a resize. Each completed move or resize is one
// annotations.transform (transform.ts). The press listens in the capture phase on the window, so a
// press on a comment wins over the text layer under it, and a press elsewhere reaches the text layer
// unchanged. The layer itself takes no pointer events.
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { fitMatrix, HANDLE_PX, handleAt, handlePoints, resizeBox } from '../edit/hitTest';
import { toasts } from '../feedback/toasts';
import { t } from '../i18n/t';
import type { CommentPageResult, PageCommentDto, RectDto } from '../rpc/generated';
import { cssBox, cssToPoints, type PagePoint, pointsToCss } from './coordinates';
import {
  COMMENT_TOL_PX,
  type CommentRef,
  commentAt,
  nextCommentSelection,
  pruneCommentSelection,
} from './hitTest';
import { NotePopup } from './NotePopup';
import type { CommentPageCache } from './pageCache';
import { NOT_PAGE_SELECTOR } from './pageGuard';
import { isMoveClick, transformComments, type TransformDeps, translation } from './transform';
import './comments.css';

// Keys that belong to a field or a dialog, so Escape there is theirs, not the selection's.
const KEY_OWNER_SELECTOR =
  'input, textarea, select, [contenteditable], [role=dialog], [role=menu], .comments-panel';

// The gap between a note and its popup, in CSS pixels (the desktop's 12 px offset).
const NOTE_POPUP_GAP_PX = 12;

// A gesture in progress, in page points. A move carries the comments that move (the movable
// selected ones on this page); a click without a move then selects only the pressed comment when
// `collapse` is set (a multi-selection), and opens the popup when the press was on a note (`note`).
// A resize carries the one comment, its handle and its box at the press.
type Drag =
  | {
      readonly kind: 'move';
      readonly start: PagePoint;
      readonly end: PagePoint;
      readonly refs: readonly CommentRef[];
      readonly press: CommentRef;
      readonly collapse: boolean;
      readonly note: boolean;
    }
  | {
      readonly kind: 'resize';
      readonly start: PagePoint;
      readonly end: PagePoint;
      readonly ref: CommentRef;
      readonly handle: number;
      readonly box: RectDto;
    };

export interface CommentSelectLayerProps {
  readonly cache: CommentPageCache;
  readonly page: number;
  readonly revision: number;
  readonly zoom: number;
  // The selection of the whole document: a comment on any page may be in it.
  readonly selection: readonly CommentRef[];
  readonly onSelect: (next: readonly CommentRef[]) => void;
  // The engine and the undo toast a move or a resize uses (annotations.transform).
  readonly transformDeps: TransformDeps;
  // The note whose popup is open, over the whole document (one popup at a time, as the desktop).
  // The setter takes an updater, so a popup closing does not clear a popup opened since.
  readonly openNote: CommentRef | null;
  readonly onOpenNote: Dispatch<SetStateAction<CommentRef | null>>;
}

// Whether the named comment of this page is in the selection.
function selectedOn(selection: readonly CommentRef[], page: number, name: string): boolean {
  return selection.some((r) => r.page === page && r.name === name);
}

// A pointer position in page points, from the layer's box (the page's top-left corner).
function pointIn(layer: HTMLElement, event: PointerEvent, zoom: number): PagePoint {
  const box = layer.getBoundingClientRect();
  return {
    x: cssToPoints(event.clientX - box.left, zoom),
    y: cssToPoints(event.clientY - box.top, zoom),
  };
}

// The box a resize gesture gives: the handle moves by the pointer's travel since the press, so a
// press a little off the handle (handleAt takes a few px) does not jump the edge to the pointer.
function resizedBox(d: Extract<Drag, { kind: 'resize' }>): RectDto {
  const handle = handlePoints(d.box)[d.handle];
  if (handle === undefined) return d.box;
  const dx = d.end.x - d.start.x;
  const dy = d.end.y - d.start.y;
  return resizeBox(d.box, d.handle, { x: handle.x + dx, y: handle.y + dy });
}

export function CommentSelectLayer({
  cache,
  page,
  revision,
  zoom,
  selection,
  onSelect,
  transformDeps,
  openNote,
  onOpenNote,
}: CommentSelectLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<CommentPageResult | null>(null);
  // The latest answer, read by an open popup when it closes: a note the page no longer holds is not
  // saved (its unmount runs after the render that dropped it, so the state is not read there).
  const latestReply = useRef<CommentPageResult | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Ends the gesture in progress (it removes its window listeners); null when there is none.
  const stopDrag = useRef<(() => void) | null>(null);

  // The threads are read at the revision being drawn. A list for another revision is not used, and a
  // failed read leaves the page without outlines until the next revision asks again. A reply for
  // another revision (the page moved on while it was read) is asked for once more; a second
  // mismatch is left alone, so the effect never loops.
  useEffect(() => {
    let active = true;
    const load = (retry: boolean) => {
      cache
        .get(page, revision)
        .then((next) => {
          if (!active) return;
          latestReply.current = next;
          setReply(next);
          if (next.revision !== revision && retry) load(false);
        })
        .catch(() => undefined);
    };
    load(true);
    return () => {
      active = false;
    };
  }, [cache, page, revision]);

  // A change to the page under a gesture drops it: a move is relative, so a drag applied after an
  // undo would move the comment from its restored place (W7.1a section 3.4). The unmount ends it too.
  useEffect(() => {
    stopDrag.current?.();
  }, [revision]);
  useEffect(
    () => () => {
      stopDrag.current?.();
    },
    [],
  );

  const threads = reply !== null && reply.revision === revision ? reply.threads : null;

  // A change to the page can remove a selected comment: the selection keeps only the comments the
  // page still holds, so no stale reference is left to be sent to the engine.
  useEffect(() => {
    if (threads === null) return;
    const names = new Set(threads.map((t) => t.comment.name));
    const kept = pruneCommentSelection(selection, page, names);
    if (kept.length !== selection.length) onSelect(kept);
  }, [threads, selection, page, onSelect]);

  // The window capture listener sees each press first. A press on a comment of this page is taken,
  // so the text layer does not get it; any other press clears a plain selection.
  useEffect(() => {
    // Starts a gesture: its listeners follow the pointer until it is released, then the change is
    // sent (or, for a move that did not move, a press's collapse of the selection is applied).
    const startDrag = (begin: Drag, layer: HTMLElement) => {
      stopDrag.current?.();
      setDrag(begin);
      const onMove = (event: PointerEvent) =>
        setDrag((cur) => (cur === null ? cur : { ...cur, end: pointIn(layer, event, zoom) }));
      // Sends the change a finished gesture makes: a move, or a resize that changed the box.
      function commit(d: Drag) {
        // A stale comment: the selection clears, and the page's list is read again on the next ask.
        const onStale = () => {
          cache.invalidate(page);
          onSelect([]);
        };
        if (d.kind === 'move') {
          const dx = d.end.x - d.start.x;
          const dy = d.end.y - d.start.y;
          if (isMoveClick(dx, dy)) {
            if (d.collapse) onSelect([d.press]);
            if (d.note) onOpenNote(d.press);
            return;
          }
          // A locked comment is not moved, so a drag over it sends nothing.
          if (d.refs.length === 0) return;
          void transformComments(transformDeps, d.refs, translation(dx, dy), false, onStale);
          return;
        }
        const dx = d.end.x - d.start.x;
        const dy = d.end.y - d.start.y;
        if (isMoveClick(dx, dy)) return;
        const next = resizedBox(d);
        if (
          next.x0 === d.box.x0 &&
          next.y0 === d.box.y0 &&
          next.x1 === d.box.x1 &&
          next.y1 === d.box.y1
        ) {
          return;
        }
        void transformComments(transformDeps, [d.ref], fitMatrix(d.box, next), true, onStale);
      }
      function stop() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', stop);
        stopDrag.current = null;
        setDrag(null);
      }
      function finish(event: PointerEvent) {
        const end = pointIn(layer, event, zoom);
        stop();
        commit({ ...begin, end });
      }
      stopDrag.current = stop;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', stop);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const layer = layerRef.current;
      if (layer === null) return;
      // Only a press on the page itself counts: a press on a control, a field or a menu over the page
      // keeps its own behaviour and the selection stays as it is.
      const pageBox = layer.parentElement ?? layer;
      const target = event.target;
      if (!(target instanceof Node) || !pageBox.contains(target)) return;
      if (target instanceof Element && target.closest(NOT_PAGE_SELECTOR) !== null) return;
      const box = layer.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!inside) return;
      const additive = event.ctrlKey || event.metaKey;
      const point = pointIn(layer, event, zoom);
      const selectedHere = (threads ?? [])
        .map((t) => t.comment)
        .filter((c) => !c.hidden && selectedOn(selection, page, c.name));
      // A handle of the one selected comment, when it can be resized, starts a resize.
      const only = selectedHere.length === 1 ? selectedHere[0] : undefined;
      if (only !== undefined && only.resizable) {
        const handle = handleAt(only.bounds, point, cssToPoints(HANDLE_PX, zoom));
        if (handle !== null) {
          event.preventDefault();
          event.stopPropagation();
          const ref = { page, name: only.name };
          startDrag(
            { kind: 'resize', start: point, end: point, ref, handle, box: only.bounds },
            layer,
          );
          return;
        }
      }
      const hit =
        threads === null ? null : commentAt(threads, point, cssToPoints(COMMENT_TOL_PX, zoom));
      if (hit !== null) {
        event.preventDefault();
        event.stopPropagation();
        const ref = { page, name: hit.comment.name };
        const note = hit.comment.type === 'Text';
        if (additive || !selectedOn(selection, page, ref.name)) {
          onSelect(nextCommentSelection(selection, ref, additive));
          // A plain press on a note that was not selected is a gesture too: released without a move,
          // it opens the note's popup; a move moves the note (if it may move).
          if (!additive) {
            startDrag(
              {
                kind: 'move',
                start: point,
                end: point,
                refs: hit.comment.movable ? [ref] : [],
                press: ref,
                collapse: false,
                note,
              },
              layer,
            );
          }
          return;
        }
        // A press on a selected comment moves the selected comments of this page that may move. A
        // press on a locked one moves nothing; the selection stays as it is, and says why.
        const movers = selectedHere.filter((c) => c.movable).map((c) => ({ page, name: c.name }));
        if (!hit.comment.movable) {
          (transformDeps.store ?? toasts).push('info', t('comments.locked'));
        }
        startDrag(
          {
            kind: 'move',
            start: point,
            end: point,
            refs: hit.comment.movable ? movers : [],
            press: ref,
            collapse: selection.length > 1,
            note,
          },
          layer,
        );
        return;
      }
      if (!additive && selection.length > 0) onSelect([]);
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, [threads, selection, page, zoom, onSelect, onOpenNote, transformDeps, cache]);

  // Escape clears the selection, unless a dialog or another handler has taken the key.
  useEffect(() => {
    if (selection.length === 0) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('.overlay-backdrop')) return;
      const target = event.target;
      if (target instanceof Element && target.closest(KEY_OWNER_SELECTOR) !== null) return;
      event.preventDefault();
      onSelect([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, onSelect]);

  const selected: PageCommentDto[] = (threads ?? [])
    .map((t) => t.comment)
    .filter((c) => !c.hidden && selectedOn(selection, page, c.name));

  // The box a selected comment is drawn at: its bounds, moved or resized by the gesture in progress
  // (the preview; the engine is asked only when the gesture ends).
  const shown = (c: PageCommentDto): RectDto => {
    if (drag === null) return c.bounds;
    if (drag.kind === 'resize') {
      return drag.ref.name === c.name ? resizedBox(drag) : c.bounds;
    }
    if (!drag.refs.some((r) => r.name === c.name)) return c.bounds;
    const dx = drag.end.x - drag.start.x;
    const dy = drag.end.y - drag.start.y;
    const b = c.bounds;
    return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy };
  };

  // Eight handles show on the one selected comment, when it can be resized (not a locked one).
  const only = selected.length === 1 ? selected[0] : undefined;
  const resizable = only !== undefined && only.resizable ? only : null;

  // The popup of the open note, when it is on this page and the page still holds it. It is keyed by
  // its note, so a popup for another note is a new one (and the old one saves on its unmount).
  const popupThread =
    openNote !== null && openNote.page === page
      ? ((reply?.threads ?? []).find((th) => th.comment.name === openNote.name) ?? null)
      : null;
  const closePopup = (name: string) =>
    onOpenNote((cur) => (cur !== null && cur.page === page && cur.name === name ? null : cur));

  // The open note is forgotten when the page is drawn without it (deleted, or moved off), so a later
  // Select tool does not bring the popup back. The page's answer is checked at its own revision.
  useEffect(() => {
    if (openNote === null || openNote.page !== page || threads === null) return;
    if (!threads.some((th) => th.comment.name === openNote.name)) closePopup(openNote.name);
    // closePopup is rebuilt each render; the effect reads only the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNote, page, threads, onOpenNote]);
  // Leaving the Select tool (or the page's layer going away) forgets this page's open note.
  useEffect(
    () => () => onOpenNote((cur) => (cur !== null && cur.page === page ? null : cur)),
    [page, onOpenNote],
  );

  return (
    <div className="comment-select-layer" ref={layerRef} role="presentation" tabIndex={-1}>
      {popupThread !== null ? (
        <NotePopup
          key={popupThread.comment.name}
          comment={popupThread.comment}
          replies={popupThread.replies}
          deps={transformDeps}
          left={pointsToCss(popupThread.comment.bounds.x1, zoom) + NOTE_POPUP_GAP_PX}
          top={pointsToCss(popupThread.comment.bounds.y0, zoom)}
          onClose={() => closePopup(popupThread.comment.name)}
          stillOnPage={() =>
            (latestReply.current?.threads ?? []).some(
              (th) => th.comment.name === popupThread.comment.name,
            )
          }
          returnFocusTo={layerRef}
        />
      ) : null}
      {selected.map((c) => (
        <div key={c.name} className="comment-select-outline" style={cssBox(shown(c), zoom)} />
      ))}
      {resizable !== null
        ? handlePoints(shown(resizable)).map((p, i) => (
            <div
              key={`handle-${i}`}
              className="comment-select-handle"
              style={{ left: pointsToCss(p.x, zoom), top: pointsToCss(p.y, zoom) }}
            />
          ))
        : null}
    </div>
  );
}
