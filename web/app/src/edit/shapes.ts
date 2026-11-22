// The Edit tab's shape tools (W6.7b): a drag draws a rectangle, an ellipse or a line on one page,
// and one content.add_shape adds it. The gesture maths follows the desktop's _RectTool.release; the
// engine draws the shape (actions/content.py). Nothing here builds the PDF content. The image tool
// (edit/images.ts) places its box with the same gesture, as a rectangle of its own default size.
import type { PageRpc } from '../engine/engineConnection';
import type { PageRect, PagePoint } from '../comments/coordinates';
import { reportRpcError, type ToastStore, toasts } from '../feedback/toasts';
import { offerUndo } from '../feedback/undoToast';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import type { RunResult } from '../rpc/generated';
import type { RenderScheduler } from '../view/renderScheduler';
import type { ShapeTool } from '../view/viewTool';
import { isClick } from './hitTest';
import type { ObjectCache } from './objectCache';

export type ShapeKind = 'rectangle' | 'ellipse' | 'line';

// What the place layer draws: a shape, or the box an image is placed in (W6.7b slice 2a).
export type PlacedKind = ShapeKind | 'image';

export const SHAPE_KIND: Readonly<Record<ShapeTool, ShapeKind>> = {
  'shape-rectangle': 'rectangle',
  'shape-ellipse': 'ellipse',
  'shape-line': 'line',
};

// The size of a shape made by a click or by Enter, in page points (the desktop's default).
export const DEFAULT_SHAPE_WIDTH = 120;
export const DEFAULT_SHAPE_HEIGHT = 80;
// The box an image is placed in by a click or by Enter (the desktop's AddImageTool.default_size).
export const DEFAULT_IMAGE_WIDTH = 200;
export const DEFAULT_IMAGE_HEIGHT = 150;

// The default size of what a click or Enter places, in page points.
export function defaultSize(kind: PlacedKind): { width: number; height: number } {
  if (kind === 'image') return { width: DEFAULT_IMAGE_WIDTH, height: DEFAULT_IMAGE_HEIGHT };
  return { width: DEFAULT_SHAPE_WIDTH, height: DEFAULT_SHAPE_HEIGHT };
}

// The outline every web shape has: black, 1.5 pt, no fill. The desktop has no style UI either.
const SHAPE_STYLE = {
  stroke: { r: 0, g: 0, b: 0, a: 1 },
  fill: null,
  width: 1.5,
} as const;

export interface PageSize {
  readonly widthPt: number;
  readonly heightPt: number;
}

// The ShapeSpec the engine takes (model/objects.py). A box sends `rect`, a line sends `start` and
// `end`; the other pair is left out and the engine's default is used.
export interface ShapeSpec {
  readonly kind: ShapeKind;
  readonly rect?: PageRect;
  readonly start?: PagePoint;
  readonly end?: PagePoint;
  readonly stroke: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
  };
  readonly fill: null;
  readonly width: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function onPage(point: PagePoint, page: PageSize): PagePoint {
  return {
    x: clamp(point.x, 0, page.widthPt),
    y: clamp(point.y, 0, page.heightPt),
  };
}

// The spec a drag from a to b draws, or null when it draws nothing. A press that is not dragged
// gives the default size from the press point. The shape is kept on the page: a box is clipped to
// it, and a line's ends are clamped. A zero-area box, or a line with both ends in one place, is null.
// An image box is a rectangle here: the spec's `rect` is the box the picture is placed in.
export function shapeGesture(
  kind: PlacedKind,
  a: PagePoint,
  b: PagePoint,
  page: PageSize,
): ShapeSpec | null {
  const size = defaultSize(kind);
  const end = isClick(a, b) ? { x: a.x + size.width, y: a.y + size.height } : b;
  if (kind === 'line') {
    const start = onPage(a, page);
    const stop = onPage(end, page);
    if (start.x === stop.x && start.y === stop.y) return null;
    return { kind, start, end: stop, ...SHAPE_STYLE };
  }
  const rect = {
    x0: clamp(Math.min(a.x, end.x), 0, page.widthPt),
    y0: clamp(Math.min(a.y, end.y), 0, page.heightPt),
    x1: clamp(Math.max(a.x, end.x), 0, page.widthPt),
    y1: clamp(Math.max(a.y, end.y), 0, page.heightPt),
  };
  if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return null;
  return { kind: kind === 'image' ? 'rectangle' : kind, rect, ...SHAPE_STYLE };
}

// The default-size shape centred on the page, for the keyboard (Enter).
export function centredGesture(kind: PlacedKind, page: PageSize): ShapeSpec | null {
  const size = defaultSize(kind);
  const cx = page.widthPt / 2;
  const cy = page.heightPt / 2;
  return shapeGesture(
    kind,
    { x: cx - size.width / 2, y: cy - size.height / 2 },
    { x: cx + size.width / 2, y: cy + size.height / 2 },
    page,
  );
}

export interface ShapeDeps {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly cache: Pick<ObjectCache, 'clear'>;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  readonly store?: ToastStore;
}

// Says that a gesture drew nothing (a zero-area box, or a click at the page's far corner).
export function noteShapeTooSmall(store: ToastStore = toasts): void {
  store.push('info', t('edit.shape.tooSmall'));
}

// Shows the undo offer for an add that the engine made. Undoing moves the engine's history back,
// so the object lists of the old state are dropped and the pages are re-rendered.
export function offerAddUndo(deps: ShapeDeps, message: string, reply: RunResult): void {
  const store = deps.store ?? toasts;
  offerUndo('info', message, {
    rpc: deps.rpc,
    handle: deps.handle,
    history: reply.state.history,
    onUndone: (undone) => {
      deps.cache.clear();
      deps.scheduler.noteRevisions(undone.changed?.revisions ?? {});
    },
    store,
  });
}

// Adds the shape to the page with one actions.run and returns true when the engine made it. A
// failure is shown and returns false, so the caller keeps the tool on and the user can retry.
export async function addShape(deps: ShapeDeps, page: number, spec: ShapeSpec): Promise<boolean> {
  const store = deps.store ?? toasts;
  let reply: RunResult;
  try {
    reply = await deps.rpc.call('actions.run', {
      handle: deps.handle,
      name: 'content.add_shape',
      args: { page, spec },
    });
  } catch (error) {
    if (error instanceof RpcError) reportRpcError(store, error);
    else store.push('error', t('edit.failed'));
    return false;
  }
  if (!reply.executed) return false;
  deps.scheduler.noteRevisions(reply.changed?.revisions ?? {});
  offerAddUndo(deps, t('edit.shape.added'), reply);
  return true;
}
