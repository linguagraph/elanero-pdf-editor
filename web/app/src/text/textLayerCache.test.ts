import { describe, expect, it, vi } from 'vitest';
import type { Methods } from '../rpc/generated';
import { MAX_TEXT_LAYERS, TextLayerCache, type TextRpc } from './textLayerCache';

function layerReply(text: string): Methods['text.layer']['result'] {
  return {
    revision: 0,
    text,
    line_rects: [],
    char_boxes: new Float32Array(text.length * 4).fill(1).buffer,
    line_numbers: new Uint32Array(text.length).buffer,
  };
}

function fakeRpc() {
  const call = vi.fn((method: string, params: unknown) => {
    const { page } = params as { page: number };
    return Promise.resolve(layerReply(`page ${page}`));
  });
  return { rpc: { call } as unknown as TextRpc, call };
}

describe('TextLayerCache', () => {
  it('asks the engine once per page and revision', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new TextLayerCache(rpc, 'doc-1');
    const first = await cache.get(2, 0);
    const again = await cache.get(2, 0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('text.layer', { handle: 'doc-1', page: 2 });
    expect(again).toBe(first);
  });

  it('asks again when the page revision changes', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new TextLayerCache(rpc, 'doc-1');
    await cache.get(0, 0);
    await cache.get(0, 1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed request, so the next ask tries again', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(layerReply('ok'));
    const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
    await expect(cache.get(0, 0)).rejects.toThrow('busy');
    await expect(cache.get(0, 0)).resolves.toEqual([expect.objectContaining({ text: 'ok' })]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('does not keep a pending entry that was evicted before it arrived', async () => {
    let release!: (reply: Methods['text.layer']['result']) => void;
    const held = new Promise<Methods['text.layer']['result']>((resolve) => {
      release = resolve;
    });
    const call = vi.fn((_method: string, params: unknown) => {
      const { page } = params as { page: number };
      return page === 0 ? held : Promise.resolve(layerReply(`page ${page}`));
    });
    const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
    const pending = cache.get(0, 0);
    // The cap is 300: these asks push page 0 (still pending) out of the cache.
    for (let page = 1; page <= MAX_TEXT_LAYERS; page += 1) await cache.get(page, 0);
    release(layerReply('late'));
    await pending;
    expect(cache.ready(0, 0)).toBeUndefined();
    expect(cache.ready(1, 0)).toBeDefined();
  });

  it('keeps at most the cap of layers, dropping the oldest', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new TextLayerCache(rpc, 'doc-1');
    for (let page = 0; page <= MAX_TEXT_LAYERS; page += 1) await cache.get(page, 0);
    expect(call).toHaveBeenCalledTimes(MAX_TEXT_LAYERS + 1);
    await cache.get(MAX_TEXT_LAYERS, 0);
    expect(call).toHaveBeenCalledTimes(MAX_TEXT_LAYERS + 1);
    await cache.get(0, 0);
    expect(call).toHaveBeenCalledTimes(MAX_TEXT_LAYERS + 2);
  });
});
