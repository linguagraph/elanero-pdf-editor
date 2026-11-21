import { describe, expect, it, vi } from 'vitest';
import type { LinkDto, LinksResult } from '../rpc/generated';
import { LinkCache, MAX_LINK_LISTS, type LinksRpc, sortLinks } from './linkCache';

function link(x0: number, y0: number, page: number): LinkDto {
  return { rect: { x0, y0, x1: x0 + 10, y1: y0 + 5 }, kind: 'goto', page, top: null, uri: '' };
}

function reply(revision: number, links: LinkDto[] = [link(0, 0, 1)]): LinksResult {
  return { revision, links, truncated: false };
}

// A fake engine: the revision each page is at is set by the test, and failures are counted down.
function fakeRpc(failures = 0) {
  const revisions = new Map<number, number>();
  let remaining = failures;
  const call = vi.fn((_method: string, params: { page: number }) => {
    const revision = revisions.get(params.page) ?? 0;
    if (remaining > 0) {
      remaining -= 1;
      return Promise.reject(new Error('engine failed'));
    }
    return Promise.resolve(reply(revision));
  });
  const rpc: LinksRpc = { call: call as unknown as LinksRpc['call'] };
  return {
    rpc,
    call,
    setRevision: (page: number, revision: number) => revisions.set(page, revision),
  };
}

describe('LinkCache', () => {
  it('asks the engine once per page and revision', async () => {
    const fake = fakeRpc();
    const cache = new LinkCache(fake.rpc, 'h');
    await cache.get(0, 0);
    await cache.get(0, 0);
    expect(fake.call).toHaveBeenCalledTimes(1);
    expect(fake.call).toHaveBeenCalledWith('session.links', { handle: 'h', page: 0 });
  });

  it('keeps the links once they have arrived, sorted in reading order', async () => {
    const fake = fakeRpc();
    fake.setRevision(0, 2);
    const unsorted = [link(50, 100, 1), link(10, 100, 2), link(90, 10, 3)];
    const cache = new LinkCache(
      { call: vi.fn(() => Promise.resolve(reply(2, unsorted))) as unknown as LinksRpc['call'] },
      'h',
    );
    expect(cache.ready(0, 2)).toBeUndefined();
    await cache.get(0, 2);
    expect(cache.ready(0, 2)?.map((item) => item.page)).toEqual([3, 2, 1]);
  });

  it('answers a reply at another revision without keeping it under the asked key', async () => {
    const fake = fakeRpc();
    fake.setRevision(0, 5);
    const cache = new LinkCache(fake.rpc, 'h');
    const answered = await cache.get(0, 4);
    expect(answered.revision).toBe(5);
    expect(cache.ready(0, 4)).toBeUndefined();
    await cache.get(0, 4);
    expect(fake.call).toHaveBeenCalledTimes(2);
  });

  it('drops the older lists of a page when a newer revision is asked', async () => {
    const fake = fakeRpc();
    const cache = new LinkCache(fake.rpc, 'h');
    fake.setRevision(0, 1);
    await cache.get(0, 1);
    expect(cache.ready(0, 1)).toBeDefined();
    fake.setRevision(0, 2);
    await cache.get(0, 2);
    expect(cache.ready(0, 1)).toBeUndefined();
    expect(cache.ready(0, 2)).toBeDefined();
  });

  it('forgets a failed request, so the next ask retries', async () => {
    const fake = fakeRpc(1);
    const cache = new LinkCache(fake.rpc, 'h');
    await expect(cache.get(0, 0)).rejects.toThrow('engine failed');
    await expect(cache.get(0, 0)).resolves.toMatchObject({ revision: 0 });
    expect(fake.call).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used list at the limit', async () => {
    const fake = fakeRpc();
    const cache = new LinkCache(fake.rpc, 'h');
    for (let page = 0; page <= MAX_LINK_LISTS; page += 1) await cache.get(page, 0);
    expect(cache.ready(0, 0)).toBeUndefined();
    expect(cache.ready(MAX_LINK_LISTS, 0)).toBeDefined();
  });
});

describe('sortLinks', () => {
  it('orders by top edge, then left edge, without changing the input', () => {
    const input = [link(50, 10, 1), link(10, 10, 2), link(0, 5, 3)];
    const sorted = sortLinks(input);
    expect(sorted.map((item) => item.page)).toEqual([3, 2, 1]);
    expect(input[0]?.page).toBe(1);
  });
});
