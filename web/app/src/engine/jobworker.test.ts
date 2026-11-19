import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineHandle, LoadOptions } from './loader';
import { FORBIDDEN_GLOBALS, lockDownGlobals, serveJobWorker } from './jobworker';
import type { WorkerScope } from './worker-server';

type Listener = (event: { data: unknown }) => void;

function fakeScope() {
  const listeners: Listener[] = [];
  const posted: unknown[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  const scope: WorkerScope = {
    postMessage: (message, transfer) => {
      posted.push(message);
      transfers.push(transfer);
    },
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
  const send = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  return { scope, posted, transfers, send };
}

const snapshot = () =>
  FORBIDDEN_GLOBALS.map((name) => (globalThis as Record<string, unknown>)[name] !== undefined);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('job worker network lockdown', () => {
  it('removes the forbidden globals before the engine stage, and not before Pyodide loads', async () => {
    for (const name of FORBIDDEN_GLOBALS) {
      vi.stubGlobal(name, () => undefined);
    }
    const seen: Record<string, boolean[]> = {};
    const { scope, send } = fakeScope();
    serveJobWorker(scope, async (options: LoadOptions): Promise<EngineHandle> => {
      seen.pyodide = (options.onStage?.('pyodide'), snapshot());
      seen.packages = (options.onStage?.('packages'), snapshot());
      await options.beforeEngine?.();
      seen.engine = snapshot();
      return { dispatch: () => ({ reply: '{}' }) };
    });

    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    // The load runs on the init message; wait for it to settle.
    await Promise.resolve();
    await Promise.resolve();

    // Pyodide and the packages still need fetch to load, so those stages see the globals.
    expect(seen.pyodide).toEqual(FORBIDDEN_GLOBALS.map(() => true));
    expect(seen.packages).toEqual(FORBIDDEN_GLOBALS.map(() => true));
    expect(seen.engine).toEqual(FORBIDDEN_GLOBALS.map(() => false));
  });

  it('makes each forbidden global undefined', () => {
    const host: Record<string, unknown> = {};
    for (const name of FORBIDDEN_GLOBALS) host[name] = () => undefined;
    lockDownGlobals(host);
    for (const name of FORBIDDEN_GLOBALS) expect(host[name]).toBeUndefined();
  });

  it('fails closed when a global cannot be removed', () => {
    const host: Record<string, unknown> = {};
    Object.defineProperty(host, 'fetch', {
      value: () => undefined,
      configurable: false,
      writable: false,
    });
    expect(() => lockDownGlobals(host)).toThrow(/fetch/);
  });

  it('answers job.run with the reply and its buffer, and forwards each notice first', async () => {
    const { scope, posted, send } = fakeScope();
    const seenRoles: unknown[] = [];
    serveJobWorker(scope, async (options: LoadOptions): Promise<EngineHandle> => {
      seenRoles.push(options.role);
      // A fake Python call: it sends one progress notice, then returns a reply with one buffer.
      return {
        dispatch: (request, buffers = [], onNotice) => {
          expect(JSON.parse(request).method).toBe('job.run');
          expect(buffers.map((buffer) => buffer.byteLength)).toEqual([3]);
          onNotice?.({ notice: 'progress', id: 1, data: { done: 1, total: 2, status: '' } });
          return {
            reply: JSON.stringify({ v: 1, id: 1, ok: true, result: { kind: 'files' }, events: [] }),
            buffer: new Uint8Array([7, 8]).buffer,
          };
        },
      };
    });
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    const request = JSON.stringify({ v: 1, id: 1, method: 'job.run', params: {} });
    send({ id: 4, method: 'dispatch', request, buffers: [new Uint8Array([1, 2, 3]).buffer] });
    // The answer waits for the engine, which needs a turn of the event loop.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seenRoles).toEqual(['job']);
    expect(posted).toEqual([
      {
        kind: 'notice',
        id: 4,
        notice: { notice: 'progress', id: 1, data: { done: 1, total: 2, status: '' } },
      },
      expect.objectContaining({ id: 4, reply: expect.stringContaining('"kind":"files"') }),
    ]);
    const reply = posted[1] as { buffer: ArrayBuffer };
    expect(Array.from(new Uint8Array(reply.buffer))).toEqual([7, 8]);
  });

  it('sends a reply with two buffers, both in the transfer list', async () => {
    const { scope, posted, transfers, send } = fakeScope();
    const first = new Uint8Array([1]).buffer;
    const second = new Uint8Array([2, 3]).buffer;
    serveJobWorker(scope, async () => ({
      dispatch: () => ({ reply: '{"ok":true}', buffers: [first, second] }),
    }));
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 6, method: 'dispatch', request: '{}' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const index = posted.findIndex((message) => (message as { id?: number }).id === 6);
    const reply = posted[index] as { buffers: ArrayBuffer[] };
    expect(reply.buffers).toHaveLength(2);
    expect(reply.buffers[0]).toBe(first);
    expect(reply.buffers[1]).toBe(second);
    const transfer = transfers[index] ?? [];
    expect(transfer).toHaveLength(2);
    expect(transfer[0]).toBe(first);
    expect(transfer[1]).toBe(second);
  });

  it('answers only the dispatch method', async () => {
    const { scope, posted, send } = fakeScope();
    serveJobWorker(scope, async () => ({ dispatch: () => ({ reply: '{}' }) }));
    send({ kind: 'init', baseUrl: 'http://localhost/engine/' });
    send({ id: 9, method: 'jobs.prepare', request: '{}' });
    await Promise.resolve();
    expect(posted).toContainEqual({ id: 9, error: { message: 'unknown or malformed request' } });
  });
});
