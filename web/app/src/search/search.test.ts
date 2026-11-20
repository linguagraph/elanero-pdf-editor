import { describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import type { SearchHitDto, SearchOptionsDto } from '../rpc/generated';
import { collectSearch, hitRects, marksOnPage, nextHit, previousHit } from './search';

const OPTIONS: SearchOptionsDto = { case_sensitive: false, whole_word: false, regex: false };

function hit(page: number, x = 10): SearchHitDto {
  return {
    page,
    text: 'cat',
    context: `[cat] on ${page}`,
    quads: [
      {
        ul: { x, y: 20 },
        ur: { x: x + 30, y: 20 },
        ll: { x, y: 32 },
        lr: { x: x + 30, y: 32 },
      },
    ],
  };
}

function slice(hits: SearchHitDto[], pagesDone: number, done: boolean) {
  return { hits, cursor: done ? null : `c${pagesDone}`, pages_done: pagesDone, total: 4, done };
}

describe('nextHit and previousHit', () => {
  it('move through the hits and wrap at both ends', () => {
    expect(nextHit(-1, 3)).toBe(0);
    expect(nextHit(0, 3)).toBe(1);
    expect(nextHit(2, 3)).toBe(0);
    expect(previousHit(-1, 3)).toBe(2);
    expect(previousHit(2, 3)).toBe(1);
    expect(previousHit(0, 3)).toBe(2);
  });

  it('select nothing when there are no hits', () => {
    expect(nextHit(-1, 0)).toBe(-1);
    expect(previousHit(-1, 0)).toBe(-1);
  });
});

describe('hitRects and marksOnPage', () => {
  it('turns each quad into a box in CSS pixels at the zoom', () => {
    const [rect] = hitRects(hit(0, 10), 2, true);
    const k = 2 * (96 / 72);
    expect(rect).toEqual({
      left: 10 * k,
      top: 20 * k,
      width: 30 * k,
      height: 12 * k,
      current: true,
    });
  });

  it('marks only the hits of the page, and the selected hit as current', () => {
    const marks = { hits: [hit(0), hit(1), hit(1, 50)], current: 2 };
    const onPage1 = marksOnPage(marks, 1, 1);
    expect(onPage1.map((rect) => rect.current)).toEqual([false, true]);
    expect(marksOnPage(marks, 2, 1)).toEqual([]);
    expect(marksOnPage(undefined, 0, 1)).toEqual([]);
  });
});

describe('collectSearch', () => {
  it('passes each slice to the caller in order, and reports done', async () => {
    const chunked = vi.fn(async function* () {
      yield slice([hit(0)], 2, false);
      yield slice([hit(3)], 4, true);
    });
    const seen: number[][] = [];
    const run = await collectSearch(
      { chunked } as unknown as Pick<PageRpc, 'chunked'>,
      'doc-1',
      'cat',
      OPTIONS,
      0,
      new AbortController().signal,
      (hits) => seen.push(hits.map((h) => h.page)),
    );
    expect(run).toBe('done');
    expect(seen).toEqual([[0], [3]]);
    expect(chunked).toHaveBeenCalledWith(
      'text.search',
      expect.objectContaining({ handle: 'doc-1', query: 'cat', start_page: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('starts at the given page, so the search wraps from the current page', async () => {
    const chunked = vi.fn(async function* () {
      yield slice([hit(3)], 4, true);
    });
    await collectSearch(
      { chunked } as unknown as Pick<PageRpc, 'chunked'>,
      'doc-1',
      'cat',
      OPTIONS,
      3,
      new AbortController().signal,
      () => undefined,
    );
    expect(chunked).toHaveBeenCalledWith(
      'text.search',
      expect.objectContaining({ start_page: 3 }),
      expect.any(Object),
    );
  });

  it('stops without another slice when the signal is aborted', async () => {
    const controller = new AbortController();
    const chunked = vi.fn(async function* () {
      yield slice([hit(0)], 1, false);
      controller.abort();
      yield slice([hit(1)], 2, false);
    });
    const seen: number[][] = [];
    const run = await collectSearch(
      { chunked } as unknown as Pick<PageRpc, 'chunked'>,
      'doc-1',
      'cat',
      OPTIONS,
      0,
      controller.signal,
      (hits) => seen.push(hits.map((h) => h.page)),
    );
    expect(run).toBe('stopped');
    expect(seen).toEqual([[0]]);
  });

  it('rethrows an engine error', async () => {
    const chunked = vi.fn(async function* () {
      yield* [];
      throw new Error('bad pattern');
    });
    await expect(
      collectSearch(
        { chunked } as unknown as Pick<PageRpc, 'chunked'>,
        'doc-1',
        '(',
        { ...OPTIONS, regex: true },
        0,
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toThrow('bad pattern');
  });
});
