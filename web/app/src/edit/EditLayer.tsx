// The Edit tool's gesture layer over one page (W6.7a S4). It outlines every content object the engine
// lists for the page, selects them by click, Ctrl+click and rubber band, and shows the eight handles
// of a single selected object. A drag previews a move or a resize, and its release commits it (the
// engine call is in commit.ts, through the parent's onCommit). The gestures port the desktop's
// EditObjectsTool, with the geometry from hitTest.ts and selection.ts.
import { type PointerEvent, useEffect, useState } from 'react';
import { cssBox, cssToPoints, type PageRect, rectBetween } from '../comments/coordinates';
import type { MessageId } from '../i18n/en';
import { t } from '../i18n/t';
import type { ContentObjectsResult, PageObjectDto, RectDto } from '../rpc/generated';
import type { EditChange } from './commit';
import {
  fitMatrix,
  HANDLE_PX,
  handleAt,
  handlePoints,
  isClick,
  objectAt,
  OBJECT_TOL_PX,
  type Point,
  resizeBox,
} from './hitTest';
import type { ObjectCache } from './objectCache';
import { clickSelection, rubberSelection, type Selection } from './selection';
import './edit.css';

// A drag this short, in page points on both axes, is a click.
const CLICK_PT = 0.5;

const NONE: Selection = [];
const NO_OBJECTS: readonly PageObjectDto[] = [];

// The selection of one page at one revision. Keys are valid only for their revision, so a selection
// made before an edit is ignored by the layer, not reused.
export interface EditSelection {
  readonly page: number;
  readonly revision: number;
  readonly keys: Selection;
}

export interface EditLayerProps {
  readonly cache: ObjectCache;
  readonly page: number;
  readonly revision: number;
  readonly zoom: number;
  readonly selection: EditSelection | null;
  readonly onSelect: (selection: EditSelection) => void;
  // A drag that ends past the click threshold: the parent makes the edit.
  readonly onCommit: (change: EditChange) => void;
}

// A press on the page. `onClick` is the selection a click (a press without a drag) leaves. A move
// press on an already selected object keeps the selection until the press is known to be a click.
type Gesture =
  | {
      readonly kind: 'band';
      readonly start: Point;
      readonly current: Point;
      readonly additive: boolean;
      readonly onClick: Selection;
    }
  | {
      readonly kind: 'move';
      readonly start: Point;
      readonly current: Point;
      readonly moving: readonly string[];
      readonly onClick: Selection | null;
    }
  | {
      readonly kind: 'resize';
      readonly start: Point;
      readonly current: Point;
      readonly key: string;
      readonly box: RectDto;
      readonly handle: number;
    };

// The explanations the engine's reasons map to; any other reason gets the generic one.
const REASON_KEYS: Readonly<Record<string, MessageId>> = {
  "rotated or vertical text can't be edited yet": 'edit.reason.rotated',
  "text in Type3 fonts can't be edited": 'edit.reason.type3',
};

function reasonText(reason: string): string {
  const id = REASON_KEYS[reason];
  return id === undefined ? t('edit.reason.other') : t(id);
}

function translate(box: RectDto, dx: number, dy: number): RectDto {
  return { x0: box.x0 + dx, y0: box.y0 + dy, x1: box.x1 + dx, y1: box.y1 + dy };
}

export function EditLayer({
  cache,
  page,
  revision,
  zoom,
  selection,
  onSelect,
  onCommit,
}: EditLayerProps) {
  const [reply, setReply] = useState<ContentObjectsResult | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  // A list that fails leaves the page without outlines; the next revision asks again.
  useEffect(() => {
    let active = true;
    cache
      .get(page, revision)
      .then((next) => {
        if (active) setReply(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [cache, page, revision]);

  // The list only counts for the revision its keys belong to.
  const list = reply !== null && reply.revision === revision ? reply : null;
  const objects = list?.objects ?? NO_OBJECTS;
  const keys =
    selection !== null && selection.page === page && selection.revision === revision
      ? selection.keys
      : NONE;
  const selected = objects.filter((o) => keys.includes(o.key));
  const tol = cssToPoints(OBJECT_TOL_PX, zoom);
  const handleTol = cssToPoints(HANDLE_PX, zoom);

  const select = (next: Selection) => onSelect({ page, revision, keys: next });
  const pointOf = (event: PointerEvent<HTMLDivElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: cssToPoints(event.clientX - box.left, zoom),
      y: cssToPoints(event.clientY - box.top, zoom),
    };
  };

  // The box an object is drawn at: moved or resized while a gesture previews it.
  const boxOf = (o: PageObjectDto): RectDto => {
    if (gesture?.kind === 'move' && gesture.moving.includes(o.key)) {
      const dx = gesture.current.x - gesture.start.x;
      const dy = gesture.current.y - gesture.start.y;
      return translate(o.bbox, dx, dy);
    }
    if (gesture?.kind === 'resize' && gesture.key === o.key) {
      return resizeBox(gesture.box, gesture.handle, gesture.current);
    }
    return o.bbox;
  };

  const onDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const p = pointOf(event);
    const additive = event.ctrlKey || event.metaKey;
    // A single selected, editable object shows its handles; a press on one resizes it.
    const single = selected.length === 1 ? selected[0] : undefined;
    if (single !== undefined && single.editable) {
      const handle = handleAt(boxOf(single), p, handleTol);
      if (handle !== null) {
        setGesture({
          kind: 'resize',
          start: p,
          current: p,
          key: single.key,
          box: single.bbox,
          handle,
        });
        return;
      }
    }
    const hit = objectAt(objects, p, tol);
    if (hit === null) {
      const onClick = clickSelection(keys, objects, p, tol, additive);
      setGesture({ kind: 'band', start: p, current: p, additive, onClick });
      return;
    }
    if (keys.includes(hit.key) && !additive) {
      // The selection stays while the press may still become a move; a click then selects only it.
      const moving = selected.filter((o) => o.editable).map((o) => o.key);
      const onClick = clickSelection(keys, objects, p, tol, false);
      setGesture({ kind: 'move', start: p, current: p, moving, onClick });
      return;
    }
    const next = clickSelection(keys, objects, p, tol, additive);
    select(next);
    const moving = objects.filter((o) => next.includes(o.key) && o.editable).map((o) => o.key);
    setGesture({ kind: 'move', start: p, current: p, moving, onClick: null });
  };

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const p = pointOf(event);
    if (gesture !== null) {
      setGesture({ ...gesture, current: p });
      return;
    }
    const hit = objectAt(objects, p, tol);
    setHover(hit !== null && !hit.editable ? reasonText(hit.reason) : null);
  };

  // Ends the press on release, or when the pointer leaves the page (the gesture then stops there).
  // A move or a resize that was dragged is committed; a click only changes the selection.
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture === null) return;
    const p = pointOf(event);
    const click = isClick(gesture.start, p, CLICK_PT);
    if (gesture.kind === 'band') {
      if (click) select(gesture.onClick);
      else select(rubberSelection(keys, objects, rectBetween(gesture.start, p), gesture.additive));
    } else if (gesture.kind === 'move') {
      if (click) {
        if (gesture.onClick !== null) select(gesture.onClick);
      } else {
        const dx = p.x - gesture.start.x;
        const dy = p.y - gesture.start.y;
        const moved = objects.filter((o) => gesture.moving.includes(o.key));
        onCommit({
          kind: 'move',
          page,
          revision,
          objects: moved,
          matrix: [1, 0, 0, 1, dx, dy],
          boxes: moved.map((o) => translate(o.bbox, dx, dy)),
        });
      }
    } else if (!click) {
      const target = objects.find((o) => o.key === gesture.key);
      if (target !== undefined) {
        const box = resizeBox(gesture.box, gesture.handle, p);
        onCommit({
          kind: 'resize',
          page,
          revision,
          objects: [target],
          matrix: fitMatrix(target.bbox, box),
          boxes: [box],
        });
      }
    }
    setGesture(null);
  };

  const single = selected.length === 1 ? selected[0] : undefined;
  const radius = handleTol / 2;
  const handles = single === undefined || !single.editable ? [] : handlePoints(boxOf(single));
  const blocked = hover !== null;

  return (
    <div
      className={blocked ? 'edit-layer edit-layer--blocked' : 'edit-layer'}
      role="presentation"
      title={hover ?? undefined}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={finish}
      onPointerLeave={(event) => {
        finish(event);
        setHover(null);
      }}
    >
      {objects.map((o) => {
        const classes = ['edit-outline'];
        if (!o.editable) classes.push('edit-outline--off');
        if (keys.includes(o.key)) classes.push('edit-outline--selected');
        return (
          <div
            key={o.key}
            className={classes.join(' ')}
            data-key={o.key}
            style={cssBox(boxOf(o) as PageRect, zoom)}
          />
        );
      })}
      {handles.map((h, index) => (
        <div
          key={index}
          className="edit-handle"
          data-handle={index}
          style={cssBox(
            { x0: h.x - radius, y0: h.y - radius, x1: h.x + radius, y1: h.y + radius },
            zoom,
          )}
        />
      ))}
      {gesture?.kind === 'band' ? (
        <div
          className="edit-band"
          style={cssBox(rectBetween(gesture.start, gesture.current), zoom)}
        />
      ) : null}
      {list?.truncated ? (
        <p className="edit-note" role="status">
          {t('edit.truncated')}
        </p>
      ) : null}
    </div>
  );
}
