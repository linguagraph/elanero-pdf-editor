import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveEngineWorker } from './engine.worker';
import {
  FONTTOOLS_WHEEL_FILE,
  loadEngine,
  needsFontTools,
  type PyodideLike,
  type PyodideModule,
} from './loader';
import { WEBAPI_PROTOCOL } from './pins';
import type { WorkerScope } from './worker-server';

const BASE = 'http://localhost:3000/engine/';

// The install step is the only Python that names sysconfig.
const isInstall = (code: unknown) => String(code).includes('sysconfig');

// A Pyodide stand-in: the hello call answers, everything else is a no-op.
function fakePyodide(log: string[] = []) {
  const reply = { v: 1, id: 1, ok: true, result: { protocol: WEBAPI_PROTOCOL }, events: [] };
  const call = vi.fn(() => ({ toJs: () => [JSON.stringify(reply), undefined], destroy: vi.fn() }));
  const pyodide = {
    loadPackage: vi.fn(async () => undefined),
    runPythonAsync: vi.fn<(code: string) => Promise<undefined>>(async () => undefined),
    toPy: vi.fn(() => ({ toJs: () => undefined, destroy: vi.fn() })),
    globals: { get: vi.fn((name: string) => (name === '_pdfeditor_call' ? call : undefined)) },
    FS: {
      writeFile: vi.fn((path: string) => {
        log.push(`writeFile ${path}`);
      }),
    },
  };
  return pyodide;
}

function moduleOf(pyodide: ReturnType<typeof fakePyodide>): PyodideModule {
  return { loadPyodide: vi.fn(async () => pyodide as unknown as PyodideLike) };
}

const installCalls = (pyodide: ReturnType<typeof fakePyodide>) =>
  pyodide.runPythonAsync.mock.calls.filter(([code]) => isInstall(code));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fontTools on the web (W6.8a)', () => {
  it('stages the wheel before the network lock, and installs it only on the first call', async () => {
    const log: string[] = [];
    const pyodide = fakePyodide(log);
    const handle = await loadEngine({
      baseUrl: BASE,
      importPyodide: async () => moduleOf(pyodide),
      fetchBytes: vi.fn(async (url: string) => {
        log.push(`fetch ${url}`);
        return new ArrayBuffer(4);
      }),
      beforeEngine: () => log.push('lock'),
    });

    expect(log.indexOf(`fetch ${BASE}${FONTTOOLS_WHEEL_FILE}`)).toBeLessThan(log.indexOf('lock'));
    expect(log).toContain(`writeFile /home/pyodide/${FONTTOOLS_WHEEL_FILE}`);
    // Nothing is installed at start-up.
    expect(installCalls(pyodide)).toHaveLength(0);

    await handle.ensureFontTools?.();
    await handle.ensureFontTools?.();
    expect(installCalls(pyodide)).toHaveLength(1);
  });

  it('still loads the engine when the wheel cannot be fetched, and warns on the first edit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pyodide = fakePyodide();
    const handle = await loadEngine({
      baseUrl: BASE,
      importPyodide: async () => moduleOf(pyodide),
      fetchBytes: vi.fn(async (url: string) => {
        if (url.endsWith(FONTTOOLS_WHEEL_FILE)) throw new Error('HTTP 404');
        return new ArrayBuffer(4);
      }),
    });

    await expect(handle.ensureFontTools?.()).resolves.toBeUndefined();
    expect(installCalls(pyodide)).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('warns once, and does not retry, when the install itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pyodide = fakePyodide();
    const handle = await loadEngine({
      baseUrl: BASE,
      importPyodide: async () => moduleOf(pyodide),
      fetchBytes: async () => new ArrayBuffer(4),
    });
    pyodide.runPythonAsync.mockImplementation(async (code: string) => {
      if (isInstall(code)) throw new Error('bad zip');
      return undefined;
    });

    await handle.ensureFontTools?.();
    await handle.ensureFontTools?.();
    expect(installCalls(pyodide)).toHaveLength(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('asks for fontTools only for the text-edit actions', () => {
    const run = (name: string) =>
      JSON.stringify({
        v: 1,
        id: 3,
        method: 'actions.run',
        params: { handle: 'h', name, args: {} },
      });
    expect(needsFontTools(run('content.replace_text'))).toBe(true);
    expect(needsFontTools(run('content.add_text'))).toBe(true);
    expect(needsFontTools(run('content.transform'))).toBe(false);
    expect(needsFontTools(JSON.stringify({ v: 1, id: 4, method: 'content.objects' }))).toBe(false);
    expect(
      needsFontTools(
        JSON.stringify({ v: 1, id: 5, method: 'content.preview_font', params: { handle: 'h' } }),
      ),
    ).toBe(true);
    expect(needsFontTools('not json')).toBe(false);
  });

  it('installs fontTools before the first text edit is dispatched', async () => {
    const posted: unknown[] = [];
    const listeners: ((event: { data: unknown }) => void)[] = [];
    const scope: WorkerScope = {
      postMessage: (message) => {
        posted.push(message);
      },
      addEventListener: (_type, listener) => {
        listeners.push(listener);
      },
    };
    const order: string[] = [];
    serveEngineWorker(scope, async () => ({
      dispatch: (request) => {
        order.push(
          `dispatch ${(JSON.parse(request) as { params?: { name?: string } }).params?.name ?? ''}`,
        );
        return { reply: '{}' };
      },
      // Like the real loader, the install runs once; later calls find it done.
      ensureFontTools: (() => {
        let done = false;
        return async () => {
          if (!done) order.push('fonttools');
          done = true;
        };
      })(),
    }));
    const send = (data: unknown) => listeners.forEach((listener) => listener({ data }));
    const edit = JSON.stringify({
      v: 1,
      id: 5,
      method: 'actions.run',
      params: { handle: 'h', name: 'content.replace_text', args: {} },
    });

    send({ kind: 'init', baseUrl: BASE });
    send({ method: 'dispatch', id: 1, request: edit });
    send({ method: 'dispatch', id: 2, request: edit });
    await vi.waitFor(() => expect(posted).toHaveLength(2));

    expect(order).toEqual([
      'fonttools',
      'dispatch content.replace_text',
      'dispatch content.replace_text',
    ]);
  });
});
