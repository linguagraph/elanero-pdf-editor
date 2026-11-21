// The links of each page, one list per page and revision (W5.3). Like the object cache (W6.7a), a
// list is shown only for the revision it was read at: a reply at another revision is answered but
// not kept, a newer revision drops the page's older lists, and a failed request is forgotten so the
// next ask retries. The lists are sorted by reading order, so tab order and the link index a tap
// names follow the same sequence.
import type { LinkDto, LinksResult, Methods } from '../rpc/generated';

// The calls the link cache makes. RpcClient satisfies it; tests pass a fake.
export interface LinksRpc {
  call<M extends 'session.links'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

// The lists kept at once; the text layer keeps as many (MAX_TEXT_LAYERS).
export const MAX_LINK_LISTS = 300;

interface Entry {
  readonly page: number;
  readonly revision: number;
  readonly request: Promise<LinksResult>;
  // The sorted links, once the reply has arrived, for the synchronous reads a tap makes.
  arrived?: readonly LinkDto[];
}

// Reading order: top to bottom, then left to right.
export function sortLinks(links: readonly LinkDto[]): LinkDto[] {
  return [...links].sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0);
}

export class LinkCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly rpc: LinksRpc,
    private readonly handle: string,
  ) {}

  // The links of a page at a revision. The reply carries the revision its links belong to.
  get(page: number, revision: number): Promise<LinksResult> {
    const key = `${page}:${revision}`;
    const known = this.entries.get(key);
    if (known !== undefined) {
      // A hit becomes the most recent entry, so eviction drops the least recently used list.
      this.entries.delete(key);
      this.entries.set(key, known);
      return known.request;
    }

    // A list for a revision older than one already cached is answered but not kept.
    let newerCached = false;
    for (const other of this.entries.values()) {
      if (other.page === page && other.revision > revision) newerCached = true;
    }
    if (newerCached) {
      return this.rpc.call('session.links', { handle: this.handle, page });
    }

    // A newer revision of this page makes every older list of the page stale.
    for (const [otherKey, other] of this.entries) {
      if (other.page === page && other.revision < revision) this.entries.delete(otherKey);
    }

    const request: Promise<LinksResult> = this.rpc
      .call('session.links', { handle: this.handle, page })
      .then((reply) => {
        // Only the entry still cached under this key may store its reply.
        if (this.entries.get(key) !== entry) return reply;
        if (reply.revision === revision) entry.arrived = sortLinks(reply.links);
        else this.entries.delete(key);
        // The rest of the links are not shown; the count only helps a developer reading the console.
        if (reply.truncated) console.debug(`links: page ${page + 1} has more than the shown links`);
        return reply;
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      });
    const entry: Entry = { page, revision, request };
    this.entries.set(key, entry);

    if (this.entries.size > MAX_LINK_LISTS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return request;
  }

  // The sorted links of a page at a revision if they have arrived, else undefined. Never asks.
  ready(page: number, revision: number): readonly LinkDto[] | undefined {
    return this.entries.get(`${page}:${revision}`)?.arrived;
  }
}
