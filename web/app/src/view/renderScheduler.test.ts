import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { Methods } from '../rpc/generated';
import { MAX_RENDER_ATTEMPTS, RenderScheduler } from './renderScheduler';
import { cacheBudgetBytes } from './tiles';

type Reply = Methods['render.page']['result'];
type Pending = {
  params: Methods['render.page']['params'];
  resolve: (reply: Reply) => void;
  reject: (error: unknown) => void;
};

// A fake engine: each render.page waits until the test answers it, as the worker does in order.
function fakeRpc() {
  const renders: Pending[] = [];
  const rpc = {
    call: vi.fn(
      (_method: string, params: unknown) =>
        new Promise<Reply>((resolve, reject) => {
          renders.push({ params: params as Methods['render.page']['params'], resolve, reject });
        }),
    ),
  };
  return { rpc: rpc as unknown as PageRpc, renders };
}

function reply(revision = 0): Reply {
  return { width: 1, height: 1, revision, format: 'rgba', pixels: new ArrayBuffer(4) };
}

const plan = (pages: number[], scaleMilli = 1000) =>
  pages.map((page) => ({ page, scaleMilli, visible: true, distance: page }));

describe('RenderScheduler', () => {
  it('sends a waiting page render before the queued thumbnails when a slot opens', async () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('thumb', plan([0, 1, 2], 200));
    // Two thumbnails are in flight; a page render arrives and waits for a slot.
    scheduler.plan('page', plan([5], 1000));
    expect(renders).toHaveLength(2);
    renders[0]?.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    // The page render takes the freed slot ahead of the remaining thumbnails.
    expect(renders[2]?.params.page).toBe(5);
    expect(renders[2]?.params.scale_milli).toBe(1000);
  });

  it('holds thumbnails while a page render is waiting for a slot', () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('page', plan([0, 1, 2]));
    scheduler.plan('thumb', plan([9], 200));
    // Two requests in flight, both pages. The thumbnail waits until a page reply frees a slot.
    expect(renders.map((r) => r.params.scale_milli)).toEqual([1000, 1000]);
    renders[0]?.resolve(reply());
    return Promise.resolve().then(() => {
      expect(renders.map((r) => r.params.scale_milli)).toEqual([1000, 1000, 1000]);
      expect(renders).toHaveLength(3);
    });
  });

  it('never has more than two renders in flight in all', () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('thumb', plan([0, 1, 2, 3], 200));
    scheduler.plan('page', plan([4], 1000));
    expect(renders).toHaveLength(2);
  });

  it('stores a thumbnail under the thumbnail key, so a page lookup misses it', async () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('thumb', plan([0], 200));
    renders[0]?.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    const thumbKey = scheduler.cacheKeyOf('thumb', 0, 200);
    const pageKey = scheduler.cacheKeyOf('page', 0, 200);
    expect(scheduler.cache.has(thumbKey)).toBe(true);
    expect(scheduler.cache.has(pageKey)).toBe(false);
  });

  it('asks again at the revision the worker reports after a change', async () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('page', plan([0], 1000));
    renders[0]?.resolve(reply(7));
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.revisionOf(0)).toBe(7);
  });

  it('shows a render as failed after the last attempt fails', async () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    const key = scheduler.cacheKeyOf('thumb', 0, 200);
    for (let attempt = 0; attempt < MAX_RENDER_ATTEMPTS; attempt += 1) {
      scheduler.plan('thumb', plan([0], 200));
      renders[attempt]?.reject(new Error('boom'));
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scheduler.isFailed(key)).toBe(true);
    const sent = renders.length;
    scheduler.plan('thumb', plan([0], 200));
    expect(renders).toHaveLength(sent);
  });

  it('notifies subscribers after each reply, and not after they unsubscribe', async () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    const listener = vi.fn();
    const unsubscribe = scheduler.subscribe(listener);
    scheduler.plan('page', plan([0], 1000));
    renders[0]?.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    scheduler.plan('page', plan([1], 1000));
    renders[1]?.resolve(reply());
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('drops the queued thumbnails when the panel plans an empty list', () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('page', plan([0, 1, 2]));
    scheduler.plan('thumb', plan([8, 9], 200));
    scheduler.plan('thumb', []);
    expect(renders).toHaveLength(2);
    expect(renders.every((r) => r.params.scale_milli === 1000)).toBe(true);
  });
});

describe('RenderScheduler tiles and prefetch (W5.1b)', () => {
  it('asks render.tile for a tile, with its place in the grid and the tile size', () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('page', [
      { page: 3, scaleMilli: 1000, visible: true, distance: 0, tileX: 2, tileY: 1 },
    ]);
    expect(renders).toHaveLength(1);
    expect(renders[0]?.params).toMatchObject({ page: 3, scale_milli: 1000 });
    const tile = renders[0]?.params as unknown as Record<string, unknown>;
    expect(tile.tile_x).toBe(2);
    expect(tile.tile_y).toBe(1);
    expect(tile.tile_px).toBe(1024);
  });

  it('sends the visible renders before the prefetch pages outside the window', () => {
    const { rpc, renders } = fakeRpc();
    const scheduler = new RenderScheduler(rpc, 'h');
    scheduler.plan('page', [
      { page: 9, scaleMilli: 1000, visible: false, distance: 0 },
      { page: 4, scaleMilli: 1000, visible: true, distance: 300 },
      { page: 5, scaleMilli: 1000, visible: true, distance: 20 },
    ]);
    // Two slots: the visible pages go first, nearest first; the prefetch page waits its turn.
    expect(renders.map((r) => r.params.page)).toEqual([5, 4]);
  });

  it('takes the byte budget from the device memory', () => {
    expect(cacheBudgetBytes(2)).toBeLessThan(cacheBudgetBytes(16));
  });
});
