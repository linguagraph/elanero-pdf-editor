// The Select tool's comment selection over one page (W7.1a slice 6). The layer draws an outline
// around each selected comment and selects by press: a press on a comment selects it (Ctrl or Cmd
// toggles it), a press on empty page clears the selection, and Escape clears it. The press listens in
// the capture phase on the window, so a press on a comment wins over the text layer under it, and a
// press elsewhere reaches the text layer unchanged. The layer itself takes no pointer events.
import { useEffect, useRef, useState } from 'react';
import type { CommentPageResult, PageCommentDto } from '../rpc/generated';
import { cssBox, cssToPoints } from './coordinates';
import {
  COMMENT_TOL_PX,
  type CommentRef,
  commentAt,
  nextCommentSelection,
  pruneCommentSelection,
} from './hitTest';
import type { CommentPageCache } from './pageCache';
import './comments.css';

// What a press or a key on these is not a page press: a control, a field, a menu, a dialog or a
// popover over the page keeps its own press, so the selection does not change under it.
const NOT_PAGE_SELECTOR = [
  '.overlay-backdrop',
  'input',
  'textarea',
  'select',
  'button',
  '[role=menu]',
  '[role=menuitem]',
  '[role=dialog]',
  '[role=listbox]',
  "[class*='popover']",
  "[class*='menu']",
].join(', ');

// Keys that belong to a field or a dialog, so Escape there is theirs, not the selection's.
const KEY_OWNER_SELECTOR =
  'input, textarea, select, [contenteditable], [role=dialog], [role=menu], .comments-panel';

export interface CommentSelectLayerProps {
  readonly cache: CommentPageCache;
  readonly page: number;
  readonly revision: number;
  readonly zoom: number;
  // The selection of the whole document: a comment on any page may be in it.
  readonly selection: readonly CommentRef[];
  readonly onSelect: (next: readonly CommentRef[]) => void;
}

export function CommentSelectLayer({
  cache,
  page,
  revision,
  zoom,
  selection,
  onSelect,
}: CommentSelectLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState<CommentPageResult | null>(null);

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
      const point = {
        x: cssToPoints(event.clientX - box.left, zoom),
        y: cssToPoints(event.clientY - box.top, zoom),
      };
      const hit =
        threads === null ? null : commentAt(threads, point, cssToPoints(COMMENT_TOL_PX, zoom));
      if (hit !== null) {
        event.preventDefault();
        event.stopPropagation();
        onSelect(nextCommentSelection(selection, { page, name: hit.comment.name }, additive));
        return;
      }
      if (!additive && selection.length > 0) onSelect([]);
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, [threads, selection, page, zoom, onSelect]);

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
    .filter((c) => !c.hidden && selection.some((r) => r.page === page && r.name === c.name));

  return (
    <div className="comment-select-layer" ref={layerRef} role="presentation">
      {selected.map((c) => (
        <div key={c.name} className="comment-select-outline" style={cssBox(c.bounds, zoom)} />
      ))}
    </div>
  );
}
