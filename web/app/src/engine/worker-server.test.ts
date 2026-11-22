import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineLoadError } from './errors';
import type { EngineHandle, LoadOptions } from './loader';
import { serveEngine, type WorkerScope } from './worker-server';

type Listener = (event: { data: unknown }) => void;

// A worker scope that records what the server posts and lets the test send messages in.
function fakeScope() {
  const listeners: Listener[] = [];
  const posted: { message: unknown; transfer?: Transferable[] }[] = [];
  const scope: WorkerScope = {
    postMessage: (message, transfer) => {
      posted.push({ message, transfer });
    },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
  const send = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  return { scope, posted, send };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('serveEngine', () => {
  it('starts the load once with the base URL and forwards stage events', async () => {
    const { scope, posted, send } = fakeScope();
    const load = vi.fn(async (options: LoadOptions): Promise<EngineHandle> => {
      options.onStage?.('pyodide');
      options.onStage?.('ready');
      return { dispatch: () => ({ reply: '{}' }) };
    });
    const beforeEngine = vi.fn();
    serveEngine(scope, { load, beforeEngine });

    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ kind: 'init', baseUrl: 'http://localhost/other/' });

    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]?.[0].baseUrl).toBe('http://localhost/engine/');
    expect(load.mock.calls[0]?.[0].beforeEngine).toBe(beforeEngine);
    expect(posted.map((p) => p.message)).toEqual([
      { kind: 'stage', stage: 'pyodide' },
      { kind: 'stage', stage: 'ready' },
    ]);
  });

  it('answers a dispatch with the reply and transfers the buffer', async () => {
    const { scope, posted, send } = fakeScope();
    const out = new Uint8Array([4, 5]).buffer;
    serveEngine(scope, {
      load: async () => ({ dispatch: () => ({ reply: 'R', buffer: out }) }),
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 7, method: 'dispatch', request: '{}' });
    await flush();

    const last = posted[posted.length - 1];
    expect(last?.message).toEqual({ id: 7, reply: 'R', buffer: out });
    expect(last?.transfer).toEqual([out]);
  });

  it('hands every request buffer to the engine, in order', async () => {
    const { scope, send } = fakeScope();
    const seen: ArrayBuffer[][] = [];
    serveEngine(scope, {
      load: async () => ({
        dispatch: (_request, buffers = []) => {
          seen.push([...buffers]);
          return { reply: 'R' };
        },
      }),
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    const first = new Uint8Array([1]).buffer;
    const second = new Uint8Array([2]).buffer;
    send({ id: 8, method: 'dispatch', request: '{}', buffers: [first, second] });
    await flush();

    expect(seen).toEqual([[first, second]]);
  });

  it('answers with the load stage when the engine did not come up', async () => {
    const { scope, posted, send } = fakeScope();
    serveEngine(scope, {
      load: async () => {
        throw new EngineLoadError('packages', 'no wheel');
      },
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 1, method: 'dispatch', request: '{}' });
    await flush();

    expect(posted[posted.length - 1]?.message).toEqual({
      id: 1,
      error: { message: 'no wheel', stage: 'packages' },
    });
  });

  it('rejects methods other than dispatch and calls before init', async () => {
    const { scope, posted, send } = fakeScope();
    serveEngine(scope, { load: async () => ({ dispatch: () => ({ reply: '' }) }) });

    send({ id: 1, method: 'fetch', request: '{}' });
    send({ id: 2, method: 'dispatch', request: '{}' });
    await flush();

    expect(posted.map((p) => p.message)).toEqual([
      { id: 1, error: { message: 'unknown or malformed request' } },
      { id: 2, error: { message: 'the engine has not been started' } },
    ]);
  });

  it('turns a throwing dispatch into an error reply', async () => {
    const { scope, posted, send } = fakeScope();
    serveEngine(scope, {
      load: async () => ({
        dispatch: () => {
          throw new Error('bad envelope');
        },
      }),
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 3, method: 'dispatch', request: '{}' });
    await flush();
    expect(posted[posted.length - 1]?.message).toEqual({
      id: 3,
      error: { message: 'bad envelope' },
    });
  });
});

// A stand-in for the browser's ImageData and createImageBitmap (W5.1b S5). Node has neither.
class FakeImageData {
  constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}
}

function fakeBitmap() {
  return { close: vi.fn(), width: 0, height: 0 };
}

function renderRequest(method: string): string {
  return JSON.stringify({ v: 1, id: 7, method, params: {} });
}

function renderReply(width: number, height: number): string {
  return JSON.stringify({
    v: 1,
    id: 7,
    ok: true,
    result: { width, height, revision: 3, format: 'rgba', pixels: { $bin: 0 } },
    events: [],
  });
}

describe('serveEngine render bitmaps (W5.1b S5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Starts a worker whose engine answers one reply, sends the request, and returns what was posted.
  async function answerWith(reply: { reply: string; buffer?: ArrayBuffer }, method: string) {
    const { scope, posted, send } = fakeScope();
    serveEngine(scope, { load: async () => ({ dispatch: () => reply }) });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 7, method: 'dispatch', request: renderRequest(method) });
    await flush();
    return posted[posted.length - 1];
  }

  it('sends a render.page reply as a bitmap, outside the RPC message, and transfers it', async () => {
    const bitmap = fakeBitmap();
    const createImageBitmap = vi.fn<(image: unknown, options: unknown) => Promise<unknown>>(
      async () => bitmap,
    );
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const pixels = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]).buffer;

    const last = await answerWith({ reply: renderReply(2, 1), buffer: pixels }, 'render.page');

    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(FakeImageData), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    const image = createImageBitmap.mock.calls[0]?.[0] as unknown as FakeImageData;
    expect([image.width, image.height]).toEqual([2, 1]);
    const message = last?.message as {
      id: number;
      reply: string;
      buffer: ArrayBuffer;
      bitmap: unknown;
    };
    expect(message.id).toBe(7);
    expect(message.bitmap).toBe(bitmap);
    expect(message.buffer.byteLength).toBe(0);
    expect(JSON.parse(message.reply).result).toMatchObject({
      format: 'bitmap',
      pixels: { $bin: 0 },
    });
    expect(last?.transfer).toEqual([bitmap]);
  });

  it('keeps the ArrayBuffer reply when the worker has no createImageBitmap', async () => {
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('createImageBitmap', undefined);
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]).buffer;
    const reply = renderReply(1, 1);

    const last = await answerWith({ reply, buffer: pixels }, 'render.tile');

    expect(last?.message).toEqual({ id: 7, reply, buffer: pixels });
    expect(last?.transfer).toEqual([pixels]);
  });

  it('keeps the ArrayBuffer reply when the browser refuses the bitmap', async () => {
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('refused');
      }),
    );
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]).buffer;
    const reply = renderReply(1, 1);

    const last = await answerWith({ reply, buffer: pixels }, 'render.page');

    expect(last?.message).toEqual({ id: 7, reply, buffer: pixels });
    expect(last?.transfer).toEqual([pixels]);
  });

  it('leaves other methods and stale-revision replies unchanged', async () => {
    const createImageBitmap = vi.fn(async () => fakeBitmap());
    vi.stubGlobal('ImageData', FakeImageData);
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    const pixels = new Uint8ClampedArray([1, 2, 3, 4]).buffer;

    const other = await answerWith({ reply: renderReply(1, 1), buffer: pixels }, 'session.info');
    expect(other?.message).toEqual({ id: 7, reply: renderReply(1, 1), buffer: pixels });

    // A stale revision answers with no pixels: nothing to draw, so the reply stays as it is.
    const stale = renderReply(1, 1);
    const empty = new ArrayBuffer(0);
    const staleOut = await answerWith({ reply: stale, buffer: empty }, 'render.page');
    expect(staleOut?.message).toEqual({ id: 7, reply: stale, buffer: empty });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('serveEngine translation gate (W6.6)', () => {
  it('arms the gate only during a translation call, and disarms it when the call throws', async () => {
    const { scope, send } = fakeScope();
    const armed = { value: false };
    const seen: boolean[] = [];
    const translation = {
      arm: () => {
        armed.value = true;
      },
      disarm: () => {
        armed.value = false;
      },
      openXhr: () => {
        throw new Error('not used here');
      },
    };
    serveEngine(scope, {
      load: async () => ({
        dispatch: (request: string) => {
          seen.push(armed.value);
          if (request.includes('boom')) throw new Error('boom');
          return { reply: '{}' };
        },
      }),
      translation,
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 1, method: 'dispatch', request: '{"method":"translation.translate"}' });
    send({ id: 2, method: 'dispatch', request: '{"method":"session.info"}' });
    send({ id: 3, method: 'dispatch', request: '{"method":"translation.test","boom":1}' });
    await flush();
    expect(seen).toEqual([true, false, true]);
    expect(armed.value).toBe(false);
  });
});
