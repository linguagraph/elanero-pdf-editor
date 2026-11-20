import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Methods } from '../rpc/generated';
import { PageTextLayer } from './PageTextLayer';
import { TextLayerCache, type TextRpc } from './textLayerCache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function joinChars(boxes: Float32Array, numbers: Uint32Array): ArrayBuffer {
  const joined = new Uint8Array(boxes.byteLength + numbers.byteLength);
  joined.set(new Uint8Array(boxes.buffer), 0);
  joined.set(new Uint8Array(numbers.buffer), boxes.byteLength);
  return joined.buffer;
}

// One line "hi" at 72 points from the left and top: at zoom 1 that is 96 CSS px.
function layerReply(): Methods['text.layer']['result'] {
  return {
    revision: 0,
    text: 'hi',
    line_rects: [],
    // The boxes, then the line numbers, in the reply's one buffer.
    chars: joinChars(new Float32Array([72, 72, 84, 84, 84, 72, 96, 84]), new Uint32Array([0, 0])),
  };
}

function fakeRpc() {
  const call = vi.fn(() => Promise.resolve(layerReply()));
  return { rpc: { call } as unknown as TextRpc, call };
}

let host: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

describe('PageTextLayer', () => {
  it('places each line as a span at its CSS position for the zoom', async () => {
    const { rpc } = fakeRpc();
    const cache = new TextLayerCache(rpc, 'doc-1');
    await act(async () => {
      root.render(<PageTextLayer cache={cache} page={0} revision={0} zoom={1} />);
    });
    await flush();
    const line = host.querySelector<HTMLElement>('.page-text-line');
    expect(line?.textContent).toBe('hi');
    expect(line?.style.left).toBe(`${96}px`);
    expect(line?.style.top).toBe(`${96}px`);
    expect(line?.style.width).toBe(`${(24 * 96) / 72}px`);
  });

  it('asks for the layer once per revision and again when the revision changes', async () => {
    const { rpc, call } = fakeRpc();
    const cache = new TextLayerCache(rpc, 'doc-1');
    const render = (revision: number) =>
      act(async () => {
        root.render(<PageTextLayer cache={cache} page={0} revision={revision} zoom={1} />);
      });
    await render(0);
    await flush();
    await render(0);
    await flush();
    expect(call).toHaveBeenCalledTimes(1);
    await render(1);
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when the engine cannot give the text', async () => {
    const call = vi.fn(() => Promise.reject(new Error('gone')));
    const cache = new TextLayerCache({ call } as unknown as TextRpc, 'doc-1');
    await act(async () => {
      root.render(<PageTextLayer cache={cache} page={0} revision={0} zoom={1} />);
    });
    await flush();
    expect(host.querySelectorAll('.page-text-line')).toHaveLength(0);
  });
});
