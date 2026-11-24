// The comment threads of each page, one list per page and revision (W7.1a slice 6), read by
// comments.page for hit testing and the selection outlines. A list is valid only for the revision it
// was read at, so a newer revision of the page drops the older lists and asks again. A reply that
// names another revision than the one asked is not kept. A failed request is forgotten, so the next
// ask tries again.
import type { CommentPageResult, Methods } from '../rpc/generated';

// The calls the page cache makes. RpcClient satisfies it; tests pass a fake.
export interface CommentsRpc {
  call<M extends 'comments.page'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// A page's list is kept for the 300 most recently used asks, as the object cache does.
export const MAX_PAGE_LISTS = 300;

interface Entry {
  readonly page: number;
  readonly revision: number;
  readonly request: Promise<CommentPageResult>;
}

export class CommentPageCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly rpc: CommentsRpc,
    private readonly handle: string,
  ) {}

  // The threads of a page at a revision. The reply carries the revision it was read at.
  get(page: number, revision: number): Promise<CommentPageResult> {
    const key = `${page}:${revision}`;
    const known = this.entries.get(key);
    if (known !== undefined) {
      // A hit becomes the most recent entry, so eviction drops the least recently used list.
      this.entries.delete(key);
      this.entries.set(key, known);
      return known.request;
    }

    // A newer revision of this page makes every older list of the page stale.
    for (const [otherKey, other] of this.entries) {
      if (other.page === page && other.revision < revision) this.entries.delete(otherKey);
    }

    const request: Promise<CommentPageResult> = this.rpc
      .call('comments.page', { handle: this.handle, page })
      .then((reply) => {
        // Only the entry still cached under this key may store its reply.
        if (this.entries.get(key) !== entry) return reply;
        if (reply.revision !== revision) this.entries.delete(key);
        return reply;
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    const entry: Entry = { page, revision, request };
    this.entries.set(key, entry);

    if (this.entries.size > MAX_PAGE_LISTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return request;
  }
}
