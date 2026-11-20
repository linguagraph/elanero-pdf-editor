// The content objects the Edit tool lists, one list per page and revision (W6.7a S3). An object key
// is valid only for the revision it was listed at, so a revision change asks the engine again and
// drops the lists of older revisions of that page. A failed request is forgotten, so the next ask
// tries again.
import type { ContentObjectsResult, Methods } from '../rpc/generated';

// The calls the object cache makes. RpcClient satisfies it; tests pass a fake.
export interface ObjectsRpc {
  call<M extends 'content.objects'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// A page's list is kept for the 300 most recent asks, as the text layer cache does.
export const MAX_OBJECT_LISTS = 300;

interface Entry {
  readonly page: number;
  readonly revision: number;
  readonly request: Promise<ContentObjectsResult>;
  // The reply, once it has arrived, for the synchronous reads a hit test makes.
  arrived?: ContentObjectsResult;
}

export class ObjectCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly rpc: ObjectsRpc,
    private readonly handle: string,
  ) {}

  // The objects of a page at a revision. The reply carries the revision its keys belong to.
  get(page: number, revision: number): Promise<ContentObjectsResult> {
    const key = `${page}:${revision}`;
    const known = this.entries.get(key);
    if (known !== undefined) return known.request;

    // A newer revision of this page makes every older list of the page stale.
    for (const [otherKey, other] of this.entries) {
      if (other.page === page && other.revision < revision) this.entries.delete(otherKey);
    }

    const request: Promise<ContentObjectsResult> = this.rpc
      .call('content.objects', { handle: this.handle, page })
      .then((reply) => {
        // Only the entry still cached under this key may store its reply: an entry evicted or
        // replaced while pending must not reappear in the synchronous reads.
        if (this.entries.get(key) === entry) entry.arrived = reply;
        return reply;
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    const entry: Entry = { page, revision, request };
    this.entries.set(key, entry);

    if (this.entries.size > MAX_OBJECT_LISTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return request;
  }

  // The objects of a page at a revision if they have arrived, else undefined. It never asks the
  // engine.
  ready(page: number, revision: number): ContentObjectsResult | undefined {
    return this.entries.get(`${page}:${revision}`)?.arrived;
  }
}
