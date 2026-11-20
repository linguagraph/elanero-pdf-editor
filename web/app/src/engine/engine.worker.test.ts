import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveEngineWorker } from './engine.worker';
import { FORBIDDEN_GLOBALS } from './networkLock';
import type { EngineHandle, LoadOptions } from './loader';
import type { WorkerScope } from './worker-server';

type Listener = (event: { data: unknown }) => void;

function fakeScope() {
  const listeners: Listener[] = [];
  const scope: WorkerScope = {
    postMessage: () => undefined,
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
  };
  const send = (data: unknown) => {
    for (const listener of listeners) listener({ data });
  };
  return { scope, send };
}

const snapshot = () =>
  FORBIDDEN_GLOBALS.map((name) => (globalThis as Record<string, unknown>)[name] !== undefined);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('engine worker network lockdown (W8.6 F1)', () => {
  it('removes fetch and the other network globals after boot, but not before Pyodide loads', async () => {
    for (const name of FORBIDDEN_GLOBALS) {
      vi.stubGlobal(name, () => undefined);
    }
    const seen: Record<string, boolean[]> = {};
    const { scope, send } = fakeScope();
    serveEngineWorker(scope, async (options: LoadOptions): Promise<EngineHandle> => {
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
    // After boot, every network global is gone, so an engine call that needs the network fails.
    expect(seen.engine).toEqual(FORBIDDEN_GLOBALS.map(() => false));
    expect((globalThis as { fetch?: unknown }).fetch).toBeUndefined();
  });
});
