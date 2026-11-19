import { describe, expect, it, vi } from 'vitest';
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
