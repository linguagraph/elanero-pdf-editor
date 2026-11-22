// The Add Text tool's gesture layer over one page (W6.8a 8a-2). A drag draws the box a new text block
// goes in, a click places the default size (200 by 40 pt) from the press point, and Enter places it
// in the middle of the page. A click on an editable text block opens that block instead, as the Edit
// tool's double-click does. The box opens the paragraph editor (ParagraphEditor, 8a-1), whose commit
// is commitAdd (commit.ts). The geometry follows ShapeLayer's: a press that is not dragged is a click.
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';
import { cssBox, cssToPoints, type PagePoint, pagePointAt } from '../comments/coordinates';
import type { PageRpc } from '../engine/engineConnection';
import { t } from '../i18n/t';
import type { PageObjectDto, RectDto } from '../rpc/generated';
import type { ApplyText } from './applyText';
import type { TextEdit } from './EditLayer';
import { isClick, OBJECT_TOL_PX, objectAt, type Point } from './hitTest';
import type { ObjectCache } from './objectCache';
import { ParagraphEditor } from './ParagraphEditor';
import './edit.css';

// The box a click or Enter places, in page points (the desktop's AddTextTool default).
export const DEFAULT_TEXT_WIDTH = 200;
export const DEFAULT_TEXT_HEIGHT = 40;

interface PageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface TextBoxLayerProps {
  readonly cache: ObjectCache;
  readonly page: number;
  readonly revision: number;
  readonly zoom: number;
  // The page's size in points: the mapping from pointer offsets to page points, and the clamp.
  readonly widthPt: number;
  readonly heightPt: number;
  // Only the current page's layer takes the keyboard; the others stay out of the tab order.
  readonly focusable: boolean;
  readonly rpc: PageRpc;
  readonly handle: string;
  // The new block being typed in on this page (its `newRect` is set), or null.
  readonly editing: TextEdit | null;
  // A box was placed: the parent opens the editor on it.
  readonly onDraw: (rect: RectDto) => void;
  // A click on an editable text block: the parent opens that block in the editor instead.
  readonly onOpenText: (object: PageObjectDto) => void;
  // The editor's commit, close and drop (see ParagraphEditor, and DocumentView for the policy).
  readonly onApply: ApplyText;
  readonly onClose: () => void;
  readonly commitOnLeave: () => boolean;
  readonly onDrop: (text: string) => void;
  // Escape with no box being drawn and no editor open: the tool is turned off.
  readonly onStop: () => void;
}

// The box of `size` whose top-left corner is `at`, moved in to stay on the page, so a click near an
// edge still places the full default size.
function boxAt(at: Point, page: PageSize, size: Point): RectDto {
  const x0 = Math.min(Math.max(at.x, 0), Math.max(0, page.widthPt - size.x));
  const y0 = Math.min(Math.max(at.y, 0), Math.max(0, page.heightPt - size.y));
  return {
    x0,
    y0,
    x1: x0 + Math.min(size.x, page.widthPt),
    y1: y0 + Math.min(size.y, page.heightPt),
  };
}

// The box a drag from a to b covers, kept on the page; null when it covers no area.
function boxBetween(a: Point, b: Point, page: PageSize): RectDto | null {
  const clampX = (v: number) => Math.min(Math.max(v, 0), page.widthPt);
  const clampY = (v: number) => Math.min(Math.max(v, 0), page.heightPt);
  const rect = {
    x0: clampX(Math.min(a.x, b.x)),
    y0: clampY(Math.min(a.y, b.y)),
    x1: clampX(Math.max(a.x, b.x)),
    y1: clampY(Math.max(a.y, b.y)),
  };
  return rect.x1 <= rect.x0 || rect.y1 <= rect.y0 ? null : rect;
}

// The box a press (not dragged) places: the default size from the press point.
function clickBox(at: Point, page: PageSize): RectDto {
  return boxAt(at, page, { x: DEFAULT_TEXT_WIDTH, y: DEFAULT_TEXT_HEIGHT });
}

export function TextBoxLayer({
  cache,
  page,
  revision,
  zoom,
  widthPt,
  heightPt,
  focusable,
  rpc,
  handle,
  editing,
  onDraw,
  onOpenText,
  onApply,
  onClose,
  commitOnLeave,
  onDrop,
  onStop,
}: TextBoxLayerProps) {
  const [start, setStart] = useState<PagePoint | null>(null);
  const [current, setCurrent] = useState<PagePoint | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const size: PageSize = { widthPt, heightPt };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // When the editor closes, focus returns to the layer, so the keyboard user stays on the page.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && editing === null) layerRef.current?.focus({ preventScroll: true });
    wasEditing.current = editing !== null;
  }, [editing]);

  // The pointer offset is taken from the layer, which covers exactly the page box.
  const pointOf = (event: PointerEvent<HTMLDivElement>): PagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return pagePointAt(event.clientX - box.left, event.clientY - box.top, zoom, widthPt, heightPt);
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    // While the editor is open, a press on the page is the editor's to end, not a new box's.
    if (event.button !== 0 || editing !== null) return;
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
    if (!isClick(start, end)) {
      onDraw(boxBetween(start, end, size) ?? clickBox(start, size));
      return;
    }
    // A click on an editable text block edits that block; elsewhere it places a box. The list is
    // read first, so a click on text is not taken for an empty spot.
    const tol = cssToPoints(OBJECT_TOL_PX, zoom);
    const place = () => {
      if (alive.current) onDraw(clickBox(start, size));
    };
    cache.get(page, revision).then((list) => {
      if (!alive.current) return;
      const hit = list.revision === revision ? objectAt(list.objects, start, tol) : null;
      if (hit !== null && hit.type === 'text' && hit.editable && hit.style !== null) {
        onOpenText(hit);
      } else {
        place();
      }
    }, place);
  };

  // A cancelled pointer (the browser took it) places nothing.
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
    if (event.key === 'Enter' && start === null && editing === null) {
      event.preventDefault();
      const at = {
        x: widthPt / 2 - DEFAULT_TEXT_WIDTH / 2,
        y: heightPt / 2 - DEFAULT_TEXT_HEIGHT / 2,
      };
      onDraw(clickBox(at, size));
    }
  };

  // The outline of the box the gesture would place, as the pointer moves.
  const preview =
    start !== null && current !== null
      ? isClick(start, current)
        ? clickBox(start, size)
        : boxBetween(start, current, size)
      : null;

  return (
    <div
      ref={layerRef}
      className="text-box-layer"
      role="application"
      aria-label={t('command.add-text.label')}
      tabIndex={focusable ? 0 : -1}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onKeyDown={onKey}
    >
      {preview !== null ? <div className="shape-preview" style={cssBox(preview, zoom)} /> : null}
      {editing !== null && editing.newRect !== undefined ? (
        <ParagraphEditor
          key="new-text-block"
          object={editing.object}
          page={page}
          zoom={zoom}
          rpc={rpc}
          handle={handle}
          onApply={onApply}
          onClose={onClose}
          commitOnLeave={commitOnLeave}
          onDrop={onDrop}
          newBlock
        />
      ) : null}
    </div>
  );
}
