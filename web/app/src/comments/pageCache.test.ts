import { describe, expect, it, vi } from 'vitest';
import type { CommentPageResult } from '../rpc/generated';
import { CommentPageCache, type CommentsRpc, MAX_PAGE_LISTS } from './pageCache';

// The reply for a page at the revision the engine is at now (the test sets it per call).
function reply(revision: number): CommentPageResult {
  return { revision, threads: [] };
}

// A fake engine: the revision it answers with per call, and the number of calls it has made.
function fakeRpc(answers: number[]) {
  let next = 0;
  const call = vi.fn(() => {
    const revision = answers[Math.min(next, answers.length - 1)] ?? 0;
    next += 1;
    return Promise.resolve(reply(revision));
  });
  const rpc: CommentsRpc = { call: call as unknown as CommentsRpc['call'] };
  return { rpc, call };
}

describe('CommentPageCache', () => {
  it('asks the engine once per page and revision, then answers from the cache', async () => {
    const { rpc, call } = fakeRpc([3]);
    const cache = new CommentPageCache(rpc, 'h');
    await cache.get(0, 3);
    await cache.get(0, 3);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('comments.page', { handle: 'h', page: 0 });
  });

  it('drops the lists of an older revision of the page when a newer one is asked', async () => {
    const { rpc, call } = fakeRpc([1, 2, 2]);
    const cache = new CommentPageCache(rpc, 'h');
    await cache.get(0, 1);
    await cache.get(0, 2);
    await cache.get(0, 1);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('does not keep a reply that names another revision than the one asked', async () => {
    const { rpc, call } = fakeRpc([5, 5]);
    const cache = new CommentPageCache(rpc, 'h');
    const first = await cache.get(0, 4);
    expect(first.revision).toBe(5);
    await cache.get(0, 4);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed request, so the next ask tries again', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce(reply(1));
    const cache = new CommentPageCache({ call } as unknown as CommentsRpc, 'h');
    await expect(cache.get(0, 1)).rejects.toThrow('busy');
    await expect(cache.get(0, 1)).resolves.toEqual(reply(1));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used list past the cap', async () => {
    const { rpc, call } = fakeRpc([0]);
    const cache = new CommentPageCache(rpc, 'h');
    for (let page = 0; page < MAX_PAGE_LISTS; page++) await cache.get(page, 0);
    await cache.get(0, 0); // a hit: page 0 becomes the most recent
    await cache.get(MAX_PAGE_LISTS, 0); // evicts page 1, the least recently used
    call.mockClear();
    await cache.get(0, 0);
    await cache.get(1, 0);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
