import { describe, expect, it, vi } from 'vitest';
import { EngineLoadError } from './errors';
import { loadEngine, type PyodideLike, type PyodideModule } from './loader';
import { PYMUPDF_WHEEL_FILE, WEBAPI_PROTOCOL } from './pins';
import type { Stage } from './protocol';

const BASE = 'http://localhost:3000/engine/';

interface FakeOptions {
  protocol?: number;
  log?: string[];
}

// A Pyodide stand-in. It records the order of the calls that matter to the load.
function fakePyodide({ protocol = WEBAPI_PROTOCOL, log = [] }: FakeOptions = {}) {
  const callProxy = (request: string) => {
    const isHello = (JSON.parse(request) as { method: string }).method === 'hello';
    const reply = isHello
      ? { v: 1, id: 1, ok: true, result: { protocol, engine: 'mupdf', platform: 'web' } }
      : { v: 1, id: 2, ok: true, result: { echo: request.length } };
    const proxy = {
      toJs: () => [JSON.stringify(reply), isHello ? undefined : new Uint8Array([7, 8, 9])],
      destroy: vi.fn(),
    };
    return proxy;
  };
  const call = vi.fn((request: string) => callProxy(request));
  const pyodide = {
    loadPackage: vi.fn(async (name: string) => {
      log.push(`loadPackage ${name}`);
    }),
    runPythonAsync: vi.fn(async (code: string) => {
      if (code.includes('zipfile')) log.push('unpack');
      else if (code.includes('import pymupdf')) log.push('import pymupdf');
      else if (code.includes('_pdfeditor_call')) log.push('adapter');
      return undefined;
    }),
    toPy: vi.fn(() => ({ toJs: () => undefined, destroy: vi.fn() })),
    globals: { get: vi.fn((name: string) => (name === '_pdfeditor_call' ? call : undefined)) },
    FS: {
      writeFile: vi.fn((path: string) => {
        log.push(`writeFile ${path}`);
      }),
    },
  };
  return { pyodide, call };
}

function fakeModule(pyodide: PyodideLike): PyodideModule {
  return { loadPyodide: vi.fn(async () => pyodide) };
}

function options(overrides: Partial<Parameters<typeof loadEngine>[0]> = {}) {
  const { pyodide } = fakePyodide();
  return {
    baseUrl: BASE,
    importPyodide: vi.fn(async () => fakeModule(pyodide as unknown as PyodideLike)),
    fetchBytes: vi.fn(async () => new ArrayBuffer(4)),
    ...overrides,
  };
}

describe('loadEngine', () => {
  it('reports the stages in order and ends on ready', async () => {
    const stages: Stage[] = [];
    const { pyodide } = fakePyodide();
    await loadEngine(
      options({
        onStage: (stage) => stages.push(stage),
        importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike),
      }),
    );
    expect(stages).toEqual(['pyodide', 'packages', 'engine', 'ready']);
  });

  it('loads Pyodide, the wheel and the zip from the base URL, in that order', async () => {
    const log: string[] = [];
    const { pyodide } = fakePyodide({ log });
    const importPyodide = vi.fn(async () => fakeModule(pyodide as unknown as PyodideLike));
    const beforeEngine = vi.fn(() => log.push('beforeEngine'));
    await loadEngine(
      options({
        importPyodide,
        beforeEngine,
        fetchBytes: vi.fn(async (url: string) => {
          log.push(`fetch ${url}`);
          return new ArrayBuffer(4);
        }),
      }),
    );
    expect(importPyodide).toHaveBeenCalledWith(`${BASE}pyodide.mjs`);
    expect(pyodide.loadPackage).toHaveBeenCalledWith(`${BASE}${PYMUPDF_WHEEL_FILE}`);
    expect(log).toEqual([
      `loadPackage ${BASE}${PYMUPDF_WHEEL_FILE}`,
      'import pymupdf',
      `fetch ${BASE}pdfeditor-web.zip`,
      'writeFile /home/pyodide/pdfeditor-web.zip',
      'unpack',
      'beforeEngine',
      'adapter',
    ]);
  });

  it('runs beforeEngine after the packages and before any engine code', async () => {
    const log: string[] = [];
    const { pyodide } = fakePyodide({ log });
    await loadEngine(
      options({
        importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike),
        beforeEngine: () => log.push('beforeEngine'),
      }),
    );
    expect(log.indexOf('unpack')).toBeLessThan(log.indexOf('beforeEngine'));
    expect(log.indexOf('beforeEngine')).toBeLessThan(log.indexOf('adapter'));
  });

  it('fails with stage packages when the zip fetch fails', async () => {
    const stages: Stage[] = [];
    const error = await loadEngine(
      options({
        onStage: (stage) => stages.push(stage),
        fetchBytes: async () => {
          throw new Error('network down');
        },
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).stage).toBe('packages');
    expect((error as EngineLoadError).message).toBe('network down');
    expect(stages).toEqual(['pyodide', 'packages']);
  });

  it('fails with stage packages when the wheel loads but PyMuPDF does not import', async () => {
    // Pyodide logs a wheel it cannot fetch and resolves anyway; the import is the real check.
    const stages: Stage[] = [];
    const { pyodide } = fakePyodide();
    pyodide.runPythonAsync = vi.fn(async (code: string) => {
      if (code.includes('import pymupdf')) throw new Error('No module named pymupdf');
      return undefined;
    });
    const error = await loadEngine(
      options({
        onStage: (stage) => stages.push(stage),
        importPyodide: async () => ({ loadPyodide: async () => pyodide }),
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).stage).toBe('packages');
    expect(stages).toEqual(['pyodide', 'packages']);
  });

  it('fails with stage pyodide when the Pyodide module does not import', async () => {
    const error = await loadEngine(
      options({
        importPyodide: async () => {
          throw new Error('404');
        },
      }),
    ).catch((caught: unknown) => caught);
    expect((error as EngineLoadError).stage).toBe('pyodide');
  });

  it('fails with stage engine when the protocol does not match', async () => {
    const { pyodide } = fakePyodide({ protocol: WEBAPI_PROTOCOL + 1 });
    const error = await loadEngine(
      options({ importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike) }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).stage).toBe('engine');
  });

  it('dispatches requests and copies returned bytes, destroying the Python proxies', async () => {
    const { pyodide, call } = fakePyodide();
    const handle = await loadEngine(
      options({ importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike) }),
    );
    const input = new Uint8Array([1, 2, 3]).buffer;
    const result = handle.dispatch('{"method":"x"}', input);
    expect(result.reply).toContain('"echo"');
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.buffer as ArrayBuffer)).toEqual(new Uint8Array([7, 8, 9]));
    expect(pyodide.toPy).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2); // hello during load, then this call
    const lastProxy = call.mock.results[1]?.value as { destroy: ReturnType<typeof vi.fn> };
    expect(lastProxy.destroy).toHaveBeenCalled();
  });
});
