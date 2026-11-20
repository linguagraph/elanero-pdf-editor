// The text layers the page views ask for, one per page and revision (W1.4 section 6: 300 pages).
// A page scrolled out of view and back again does not ask the engine twice; a revision change does.
import type { Methods } from '../rpc/generated';
import { decodeTextLayer, type TextLine } from './textLayer';

// The calls the text layer makes. RpcClient satisfies it; tests pass a fake.
export interface TextRpc {
  call<M extends 'text.layer'>(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
}

export const MAX_TEXT_LAYERS = 300;

export class TextLayerCache {
  private readonly entries = new Map<string, Promise<TextLine[]>>();
  // The lines of the entries that have arrived, for the synchronous reads a selection makes.
  private readonly arrived = new Map<string, TextLine[]>();

  constructor(
    private readonly rpc: TextRpc,
    private readonly handle: string,
  ) {}

  // The lines of a page at a revision. A failed request is forgotten, so the next ask tries again.
  get(page: number, revision: number): Promise<TextLine[]> {
    const key = `${page}:${revision}`;
    const known = this.entries.get(key);
    if (known !== undefined) return known;
    // A request evicted (or replaced) while pending must not reappear in arrived: only the entry
    // that is still cached under this key may store its result.
    const pending: Promise<TextLine[]> = this.rpc
      .call('text.layer', { handle: this.handle, page })
      .then((layer) => {
        const lines = decodeTextLayer(layer);
        if (this.entries.get(key) === pending) this.arrived.set(key, lines);
        return lines;
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, pending);
    if (this.entries.size > MAX_TEXT_LAYERS) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
        this.arrived.delete(oldest);
      }
    }
    return pending;
  }

  // The lines of a page at a revision if they have arrived, else undefined. It never asks the engine.
  ready(page: number, revision: number): TextLine[] | undefined {
    return this.arrived.get(`${page}:${revision}`);
  }
}
