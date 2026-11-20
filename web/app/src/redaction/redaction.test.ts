import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import { addRedactionMark, redactionStyleJson } from './redaction';

const BOX = { x0: 72, y0: 72, x1: 144, y1: 96 };

function rpcReturning() {
  const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({
    executed: true,
    value: [{ page: 0, name: 'm1' }],
    changed: { changes: [], revisions: { '0': 4 } },
  }));
  return { call, rpc: { call } as unknown as PageRpc };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('addRedactionMark (W4.5 S3)', () => {
  it('sends the default style and no author when nothing is saved', async () => {
    const { call, rpc } = rpcReturning();
    await addRedactionMark(rpc, 'h1', 0, BOX);
    expect(call).toHaveBeenCalledWith('actions.run', {
      handle: 'h1',
      name: 'redaction.mark',
      args: {
        areas: [{ page: 0, rect: BOX }],
        author: '',
        style: {
          fill: { r: 0, g: 0, b: 0 },
          overlay_text: '',
          text_color: { r: 1, g: 1, b: 1 },
        },
      },
    });
  });

  it('sends the saved author and the saved style, read at the time of the mark', async () => {
    const { call, rpc } = rpcReturning();
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        authorName: 'Ada',
        redactionFill: '#ff8000',
        redactionOverlayText: 'REDACTED',
        redactionTextColor: '#102030',
      }),
    );
    await addRedactionMark(rpc, 'h1', 1, BOX);
    const args = call.mock.calls[0]?.[1] as { args: Record<string, unknown> };
    expect(args.args).toMatchObject({
      author: 'Ada',
      style: {
        fill: { r: 1, g: 0.502, b: 0 },
        overlay_text: 'REDACTED',
        text_color: { r: 0.0627, g: 0.1255, b: 0.1882 },
      },
    });
  });
});

describe('redactionStyleJson', () => {
  it('builds the engine MarkStyle shape with no alpha', () => {
    expect(
      redactionStyleJson({
        redactionFill: '#000000',
        redactionOverlayText: '',
        redactionTextColor: '#ffffff',
      }),
    ).toEqual({
      fill: { r: 0, g: 0, b: 0 },
      overlay_text: '',
      text_color: { r: 1, g: 1, b: 1 },
    });
  });
});
