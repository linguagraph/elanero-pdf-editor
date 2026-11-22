import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import {
  addShape,
  centredGesture,
  DEFAULT_SHAPE_HEIGHT,
  DEFAULT_SHAPE_WIDTH,
  shapeGesture,
} from './shapes';

const page = { widthPt: 600, heightPt: 800 };

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('shapeGesture', () => {
  it('draws the box between a press and a release', () => {
    expect(shapeGesture('rectangle', { x: 300, y: 200 }, { x: 100, y: 500 }, page)).toEqual({
      kind: 'rectangle',
      rect: { x0: 100, y0: 200, x1: 300, y1: 500 },
      stroke: { r: 0, g: 0, b: 0, a: 1 },
      fill: null,
      width: 1.5,
    });
  });

  it('gives the default size from the press point for a click', () => {
    const spec = shapeGesture('ellipse', { x: 50, y: 60 }, { x: 51, y: 61 }, page);
    expect(spec?.rect).toEqual({
      x0: 50,
      y0: 60,
      x1: 50 + DEFAULT_SHAPE_WIDTH,
      y1: 60 + DEFAULT_SHAPE_HEIGHT,
    });
  });

  it('clips a box dragged past the right and bottom edges to the page', () => {
    const spec = shapeGesture('rectangle', { x: 500, y: 700 }, { x: 900, y: 1000 }, page);
    expect(spec?.rect).toEqual({ x0: 500, y0: 700, x1: 600, y1: 800 });
  });

  it('draws nothing for a click on the bottom-right corner (the box would be empty)', () => {
    expect(shapeGesture('rectangle', { x: 600, y: 800 }, { x: 600, y: 800 }, page)).toBeNull();
    expect(shapeGesture('ellipse', { x: 600, y: 800 }, { x: 600, y: 800 }, page)).toBeNull();
  });

  it('draws a line between its two ends, with no rect', () => {
    const spec = shapeGesture('line', { x: 100, y: 100 }, { x: 300, y: 150 }, page);
    expect(spec).toEqual({
      kind: 'line',
      start: { x: 100, y: 100 },
      end: { x: 300, y: 150 },
      stroke: { r: 0, g: 0, b: 0, a: 1 },
      fill: null,
      width: 1.5,
    });
    expect(spec).not.toHaveProperty('rect');
  });

  it('clamps a line end that leaves the page', () => {
    expect(shapeGesture('line', { x: 100, y: 100 }, { x: 900, y: 100 }, page)?.end).toEqual({
      x: 600,
      y: 100,
    });
  });

  it('refuses a line whose clamped ends meet (a click at the corner)', () => {
    expect(shapeGesture('line', { x: 600, y: 800 }, { x: 600, y: 800 }, page)).toBeNull();
  });

  it('a click makes a line along the default diagonal', () => {
    const spec = shapeGesture('line', { x: 10, y: 10 }, { x: 11, y: 10 }, page);
    expect(spec?.end).toEqual({ x: 10 + DEFAULT_SHAPE_WIDTH, y: 10 + DEFAULT_SHAPE_HEIGHT });
  });
});

describe('centredGesture', () => {
  it('places the default-size shape in the middle of the page', () => {
    const spec = centredGesture('rectangle', page);
    expect(spec?.rect).toEqual({ x0: 240, y0: 360, x1: 360, y1: 440 });
  });

  it('places a line along the same diagonal', () => {
    const spec = centredGesture('line', page);
    expect(spec?.start).toEqual({ x: 240, y: 360 });
    expect(spec?.end).toEqual({ x: 360, y: 440 });
  });
});

function setup(executed = true) {
  // actions.run adds the shape; any other call (the Undo of the toast) gets an undo reply.
  const call = vi.fn(async (method: string) =>
    method === 'actions.run'
      ? {
          label: 'Add Rectangle',
          executed,
          value: null,
          changed: { changes: [], revisions: { '0': 3 } },
          state: { history: 7 },
        }
      : {
          done: true,
          label: 'Add Rectangle',
          changed: { changes: [], revisions: { '0': 4 } },
          state: { history: 6 },
        },
  );
  const noteRevisions = vi.fn();
  const cache = { clear: vi.fn() };
  const store = createToastStore();
  const deps = {
    rpc: { call } as unknown as PageRpc,
    handle: 'h1',
    cache,
    scheduler: { noteRevisions },
    store,
  };
  return { call, noteRevisions, cache, store, deps };
}

const boxSpec = shapeGesture('rectangle', { x: 100, y: 500 }, { x: 200, y: 560 }, page);

describe('the image box (W6.7b slice 2a)', () => {
  it('is a rectangle of 200 x 150 points from a click or Enter', () => {
    expect(shapeGesture('image', { x: 50, y: 60 }, { x: 50, y: 60 }, page)?.rect).toEqual({
      x0: 50,
      y0: 60,
      x1: 250,
      y1: 210,
    });
    expect(centredGesture('image', page)?.rect).toEqual({ x0: 200, y0: 325, x1: 400, y1: 475 });
  });

  it('keeps a dragged box as the rectangle it was drawn as', () => {
    expect(shapeGesture('image', { x: 300, y: 200 }, { x: 100, y: 500 }, page)).toMatchObject({
      kind: 'rectangle',
      rect: { x0: 100, y0: 200, x1: 300, y1: 500 },
    });
  });
});

describe('addShape', () => {
  it('runs content.add_shape with the page and the spec', async () => {
    const { call, deps } = setup();
    expect(await addShape(deps, 2, boxSpec!)).toBe(true);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'content.add_shape',
      args: { page: 2, spec: boxSpec },
    });
  });

  it('redraws the changed page and offers Undo in an info toast', async () => {
    const { noteRevisions, store, deps } = setup();
    await addShape(deps, 0, boxSpec!);
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 3 });
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('info');
    expect(toast?.text).toBe(t('edit.shape.added'));
    expect(toast?.action?.label).toBe(t('toast.undo'));
  });

  it('Undo clears the object lists and redraws the page the engine reports', async () => {
    const { call, cache, noteRevisions, store, deps } = setup();
    await addShape(deps, 0, boxSpec!);
    noteRevisions.mockClear();
    store.getState().visible[0]?.action?.run();
    await settle();
    expect(call).toHaveBeenLastCalledWith('actions.undo', { handle: 'h1', expect_history: 7 });
    expect(cache.clear).toHaveBeenCalled();
    expect(noteRevisions).toHaveBeenCalledWith({ '0': 4 });
  });

  it('an engine refusal shows its message, and the tool stays on (false)', async () => {
    const { call, noteRevisions, store, deps } = setup();
    call.mockRejectedValueOnce(new RpcError('REFUSED', 'no'));
    expect(await addShape(deps, 0, boxSpec!)).toBe(false);
    expect(noteRevisions).not.toHaveBeenCalled();
    expect(store.getState().visible.at(-1)?.kind).toBe('error');
    expect(store.getState().visible.at(-1)?.text).toBe(t('error.REFUSED'));
  });

  it('a failure that is not an RPC error shows the generic edit failure', async () => {
    const { call, store, deps } = setup();
    call.mockRejectedValueOnce(new Error('network'));
    expect(await addShape(deps, 0, boxSpec!)).toBe(false);
    expect(store.getState().visible.at(-1)?.text).toBe(t('edit.failed'));
  });

  it('shows nothing and returns false when the engine did not add the shape', async () => {
    const { store, noteRevisions, deps } = setup(false);
    expect(await addShape(deps, 0, boxSpec!)).toBe(false);
    expect(store.getState().visible).toEqual([]);
    expect(noteRevisions).not.toHaveBeenCalled();
  });
});
