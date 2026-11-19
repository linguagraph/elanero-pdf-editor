import { describe, expect, it, vi } from 'vitest';
import { EngineLoadError } from './errors';
import {
  loadEngine,
  type Notice,
  PILLOW_PACKAGE,
  type PyodideLike,
  type PyodideModule,
} from './loader';
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
      ? {
          v: 1,
          id: 1,
          ok: true,
          result: { protocol, engine: 'mupdf', platform: 'web' },
          events: [],
        }
      : { v: 1, id: 2, ok: true, result: { echo: request.length }, events: [] };
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
    expect(pyodide.loadPackage).toHaveBeenCalledWith(PILLOW_PACKAGE);
    expect(log).toEqual([
      `loadPackage ${PILLOW_PACKAGE}`,
      `loadPackage ${BASE}${PYMUPDF_WHEEL_FILE}`,
      'import pymupdf',
      `fetch ${BASE}pdfeditor-web.zip`,
      'writeFile /home/pyodide/pdfeditor-web.zip',
      'unpack',
      'beforeEngine',
      'adapter',
    ]);
  });

  it('loads Pillow by package name before the wheel, and fails the packages stage without it', async () => {
    const log: string[] = [];
    const { pyodide } = fakePyodide({ log });
    await loadEngine(
      options({ importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike) }),
    );
    expect(pyodide.loadPackage).toHaveBeenCalledWith(PILLOW_PACKAGE);
    expect(log.indexOf(`loadPackage ${PILLOW_PACKAGE}`)).toBeLessThan(
      log.indexOf(`loadPackage ${BASE}${PYMUPDF_WHEEL_FILE}`),
    );

    const failing = fakePyodide();
    failing.pyodide.loadPackage.mockImplementation(async (name: string) => {
      if (name === PILLOW_PACKAGE) throw new Error('no pillow');
    });
    const error = await loadEngine(
      options({ importPyodide: async () => fakeModule(failing.pyodide as unknown as PyodideLike) }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineLoadError);
    expect((error as EngineLoadError).stage).toBe('packages');
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
    const result = handle.dispatch('{"method":"x"}', [input]);
    expect(result.reply).toContain('"echo"');
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(result.buffer as ArrayBuffer)).toEqual(new Uint8Array([7, 8, 9]));
    // The hello call made one sizes list; this call makes the joined bytes and a sizes list.
    expect(pyodide.toPy).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenCalledTimes(2); // hello during load, then this call
    const lastProxy = call.mock.results[1]?.value as { destroy: ReturnType<typeof vi.fn> };
    expect(lastProxy.destroy).toHaveBeenCalled();
  });
});

// A Pyodide stand-in for the job worker. Its job call sends the given notice texts while a job
// runs, then answers with the given buffers (a list reply, as the job adapter returns it).
interface JobFake {
  notices?: string[];
  buffers?: Uint8Array[];
}

function fakeJobPyodide({ notices = [], buffers = [new Uint8Array([7, 8])] }: JobFake = {}) {
  const log: string[] = [];
  const call = vi.fn(
    (request: string, _joined: unknown, _sizes: unknown, onNotice?: (text: string) => void) => {
      const isHello = (JSON.parse(request) as { method: string }).method === 'hello';
      if (!isHello) for (const text of notices) onNotice?.(text);
      const reply = isHello
        ? { v: 1, id: 1, ok: true, result: { protocol: WEBAPI_PROTOCOL }, events: [] }
        : { v: 1, id: 2, ok: true, result: { kind: 'files', files: [] }, events: [] };
      return {
        toJs: () => [JSON.stringify(reply), isHello ? undefined : buffers],
        destroy: vi.fn(),
      };
    },
  );
  const pyodide = {
    loadPackage: vi.fn(async () => undefined),
    runPythonAsync: vi.fn(async (code: string) => {
      if (code.includes('_pdfeditor_job_call')) log.push('job adapter');
      else if (code.includes('_pdfeditor_call')) log.push('engine adapter');
      return undefined;
    }),
    toPy: vi.fn(() => ({ toJs: () => undefined, destroy: vi.fn() })),
    globals: {
      get: vi.fn((name: string) => (name === '_pdfeditor_job_call' ? call : undefined)),
    },
    FS: { writeFile: vi.fn() },
  };
  return { pyodide, call, log };
}

async function loadJob(fake: ReturnType<typeof fakeJobPyodide>) {
  return loadEngine({
    baseUrl: BASE,
    role: 'job',
    importPyodide: async () => fakeModule(fake.pyodide as unknown as PyodideLike),
    fetchBytes: async () => new ArrayBuffer(4),
  });
}

describe('loadEngine roles', () => {
  it('loads the job adapter for the job worker, and not the engine adapter', async () => {
    const fake = fakeJobPyodide();
    await loadJob(fake);
    expect(fake.log).toEqual(['job adapter']);
  });

  it('gives each notice of a job call to the caller as an object', async () => {
    const notice = { notice: 'progress', id: 2, data: { done: 1, total: 2, status: '' } };
    const fake = fakeJobPyodide({ notices: [JSON.stringify(notice)] });
    const handle = await loadJob(fake);
    const onNotice = vi.fn();
    handle.dispatch('{"method":"job.run"}', [new ArrayBuffer(2)], onNotice);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith(notice);
    // The job call takes the notice callback as its fourth argument.
    expect(fake.call.mock.calls.at(-1)).toHaveLength(4);
  });

  it('drops a notice that is not a JSON object', async () => {
    const fake = fakeJobPyodide({
      notices: ['not json', '[1]', 'null', '3', '"text"', ''],
    });
    const handle = await loadJob(fake);
    const onNotice = vi.fn<(notice: Notice) => void>();
    const result = handle.dispatch('{"method":"job.run"}', [], onNotice);
    expect(onNotice).not.toHaveBeenCalled();
    expect(result.reply).toContain('"kind":"files"');
  });

  it('returns a list reply as buffers, with the first also as buffer', async () => {
    const fake = fakeJobPyodide({
      buffers: [new Uint8Array([1, 2]), new Uint8Array([3])],
    });
    const handle = await loadJob(fake);
    const result = handle.dispatch('{"method":"job.run"}', []);
    expect(result.buffers?.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual([
      [1, 2],
      [3],
    ]);
    expect(Array.from(new Uint8Array(result.buffer as ArrayBuffer))).toEqual([1, 2]);
  });

  it('returns only the reply for an empty list reply', async () => {
    const fake = fakeJobPyodide({ buffers: [] });
    const handle = await loadJob(fake);
    const result = handle.dispatch('{"method":"job.run"}', []);
    expect(result).not.toHaveProperty('buffers');
    expect(result).not.toHaveProperty('buffer');
    expect(result.reply).toContain('"kind":"files"');
  });

  it('keeps the engine path: three adapter arguments and one buffer, with no list', async () => {
    const { pyodide, call } = fakePyodide();
    const handle = await loadEngine(
      options({ importPyodide: async () => fakeModule(pyodide as unknown as PyodideLike) }),
    );
    const result = handle.dispatch('{"method":"x"}', [new Uint8Array([1]).buffer]);
    expect(call.mock.calls.at(-1)).toHaveLength(3);
    expect(result.buffer).toBeInstanceOf(ArrayBuffer);
    expect(result).not.toHaveProperty('buffers');
  });
});
