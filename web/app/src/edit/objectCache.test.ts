import { describe, expect, it, vi } from 'vitest';
import type { ContentObjectsResult } from '../rpc/generated';
import { MAX_OBJECT_LISTS, ObjectCache, type ObjectsRpc } from './objectCache';

// The list the engine returns for a page: its keys carry the page and the revision it is at.
function reply(page: number, revision: number): ContentObjectsResult {
  return {
    revision,
    truncated: false,
    objects: [
      {
        type: 'image',
        key: `p${page}r${revision}`,
        bbox: { x0: 0, y0: 0, x1: 10, y1: 10 },
        text: '',
        style: null,
        editable: true,
        reason: '',
        image_size: [1, 1],
        stroke: false,
        fill: false,
      },
    ],
  };
}

// A fake engine. Its current revision per page is set by the test; failures are counted down.
function fakeRpc(failures = 0) {
  const revisions = new Map<number, number>();
  let remaining = failures;
  const call = vi.fn((_method: string, params: unknown) => {
    const { page } = params as { page: number };
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new Error('engine busy'));
    }
    return Promise.resolve(reply(page, revisions.get(page) ?? 0));
  });
  return {
    rpc: { call } as unknown as ObjectsRpc,
    call,
    setRevision: (page: number, revision: number) => revisions.set(page, revision),
  };
}

describe('ObjectCache', () => {
  it('asks the engine once per page and revision', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    const first = await cache.get(2, 0);
    const again = await cache.get(2, 0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('content.objects', { handle: 'doc-1', page: 2 });
    expect(again).toBe(first);
  });

  it('returns the revision the keys belong to', async () => {
    const { rpc, setRevision } = fakeRpc();
    setRevision(0, 4);
    const cache = new ObjectCache(rpc, 'doc-1');
    const got = await cache.get(0, 4);
    expect(got.revision).toBe(4);
    expect(got.objects[0]?.key).toBe('p0r4');
  });

  it('asks again on a revision change and drops the older lists of that page only', async () => {
    const { rpc, call, setRevision } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    await cache.get(0, 0);
    await cache.get(1, 0);
    setRevision(0, 1);
    await cache.get(0, 1);
    expect(call).toHaveBeenCalledTimes(3);
    expect(cache.ready(0, 0)).toBeUndefined();
    expect(cache.ready(0, 1)?.revision).toBe(1);
    expect(cache.ready(1, 0)?.revision).toBe(0);
  });

  it('reads an arrived list synchronously without asking the engine', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    expect(cache.ready(3, 0)).toBeUndefined();
    await cache.get(3, 0);
    expect(cache.ready(3, 0)?.objects).toHaveLength(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed request so the next ask tries again', async () => {
    const { rpc, call } = fakeRpc(1);
    const cache = new ObjectCache(rpc, 'doc-1');
    await expect(cache.get(0, 0)).rejects.toThrow('engine busy');
    expect(cache.ready(0, 0)).toBeUndefined();
    const retry = await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(2);
    expect(retry.objects[0]?.key).toBe('p0r0');
  });

  it('evicts the oldest list beyond the cap and asks again for it', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    for (let page = 0; page <= MAX_OBJECT_LISTS; page += 1) {
      await cache.get(page, 0);
    }
    expect(call).toHaveBeenCalledTimes(MAX_OBJECT_LISTS + 1);
    expect(cache.ready(0, 0)).toBeUndefined();
    expect(cache.ready(MAX_OBJECT_LISTS, 0)).toBeDefined();
    await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(MAX_OBJECT_LISTS + 2);
  });

  it('does not store a reply whose revision differs from the one asked for', async () => {
    const { rpc, call, setRevision } = fakeRpc();
    setRevision(0, 4);
    const cache = new ObjectCache(rpc, 'doc-1');
    const got = await cache.get(0, 3);
    expect(got.revision).toBe(4);
    expect(cache.ready(0, 3)).toBeUndefined();
    expect(cache.ready(0, 4)).toBeUndefined();
    await cache.get(0, 3);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps no list of an older revision beside a newer one for the same page', async () => {
    const { rpc, call, setRevision } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    setRevision(0, 1);
    await cache.get(0, 1);
    setRevision(0, 0);
    await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(2);
    expect(cache.ready(0, 1)?.revision).toBe(1);
    expect(cache.ready(0, 0)).toBeUndefined();
  });

  it('evicts the least recently used list, so a hit protects the oldest entry', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new ObjectCache(rpc, 'doc-1');
    for (let page = 0; page < MAX_OBJECT_LISTS; page += 1) {
      await cache.get(page, 0);
    }
    await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(MAX_OBJECT_LISTS);
    await cache.get(MAX_OBJECT_LISTS, 0);
    expect(cache.ready(0, 0)).toBeDefined();
    expect(cache.ready(1, 0)).toBeUndefined();
  });

  it('does not store a reply whose entry was evicted while the request was pending', async () => {
    let resolveFirst: ((value: ContentObjectsResult) => void) | undefined;
    const call = vi.fn((_method: string, params: unknown) => {
      const { page } = params as { page: number };
      if (page === 0 && resolveFirst === undefined) {
        return new Promise<ContentObjectsResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(reply(page, 0));
    });
    const cache = new ObjectCache({ call } as unknown as ObjectsRpc, 'doc-1');
    const pending = cache.get(0, 0);
    for (let page = 1; page <= MAX_OBJECT_LISTS; page += 1) {
      await cache.get(page, 0);
    }
    expect(cache.ready(0, 0)).toBeUndefined();
    resolveFirst?.(reply(0, 0));
    await pending;
    expect(cache.ready(0, 0)).toBeUndefined();
    await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(MAX_OBJECT_LISTS + 2);
  });
});
