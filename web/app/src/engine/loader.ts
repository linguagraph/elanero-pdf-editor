import { EngineLoadError } from './errors';
import { PYMUPDF_WHEEL_FILE, WEB_ZIP_FILE, WEBAPI_PROTOCOL } from './pins';
import type { FailedStage, Stage } from './protocol';

// The slice of the Pyodide API this loader uses. The real object has far more.
export interface PyProxyLike {
  toJs(): unknown;
  destroy(): void;
}

export interface PyodideLike {
  loadPackage(packages: string): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
  toPy(value: unknown): PyProxyLike;
  globals: { get(name: string): unknown };
  FS: { writeFile(path: string, data: Uint8Array): void };
}

export interface PyodideModule {
  loadPyodide(options: { indexURL: string }): Promise<PyodideLike>;
}

export interface LoadOptions {
  // Absolute, same-origin folder that holds pyodide.mjs, the PyMuPDF wheel and the web zip.
  baseUrl: string;
  onStage?: (stage: Stage) => void;
  // Runs after the packages are in place and before any engine code runs. The job worker
  // removes its network globals here: Pyodide itself still needs fetch to load packages.
  beforeEngine?: () => void;
  importPyodide?: (url: string) => Promise<PyodideModule>;
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

export interface CallResult {
  reply: string;
  buffer?: ArrayBuffer;
}

export interface EngineHandle {
  dispatch(request: string, buffer?: ArrayBuffer): CallResult;
}

export type LoadEngine = (options: LoadOptions) => Promise<EngineHandle>;

// Python run once after the packages. The zip carries the pdfeditor package at its top level.
const UNPACK_PY = `
import os, sys, zipfile
zip_path = "/home/pyodide/${WEB_ZIP_FILE}"
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall("/home/pyodide")
os.remove(zip_path)
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
`;

// Python run once before the first call. It holds the only function the JS side calls: bytes in,
// bytes out, at most one buffer each way.
const ADAPTER_PY = `
from pdfeditor.webapi import dispatch as _dispatch

def _pdfeditor_call(request, buffer):
    buffers = [] if buffer is None else [bytes(buffer)]
    reply, out = _dispatch(request, buffers)
    if len(out) > 1:
        raise ValueError("a reply carries at most one buffer")
    return reply, (memoryview(out[0]) if out else None)
`;

const HELLO_REQUEST = JSON.stringify({ v: WEBAPI_PROTOCOL, id: 1, method: 'hello', params: {} });

type PyCallable = (request: string, buffer: PyProxyLike | undefined) => unknown;

const defaultImport = (url: string): Promise<PyodideModule> =>
  import(/* @vite-ignore */ url) as Promise<PyodideModule>;

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return response.arrayBuffer();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Runs one load step. Any failure leaves as a typed error that names the step.
async function attempt<T>(stage: FailedStage, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new EngineLoadError(stage, messageOf(error), { cause: error });
  }
}

function asProxy(value: unknown): PyProxyLike {
  const candidate = value as Partial<PyProxyLike> | null | undefined;
  if (typeof candidate?.toJs === 'function' && typeof candidate.destroy === 'function') {
    return candidate as PyProxyLike;
  }
  throw new Error('expected a Python result');
}

function makeDispatch(pyodide: PyodideLike, call: PyCallable): EngineHandle['dispatch'] {
  return (request, buffer) => {
    let input: PyProxyLike | undefined;
    let output: PyProxyLike | undefined;
    try {
      input = buffer === undefined ? undefined : pyodide.toPy(new Uint8Array(buffer));
      output = asProxy(call(request, input));
      const [reply, bytes] = output.toJs() as [unknown, unknown];
      if (typeof reply !== 'string') throw new Error('the reply is not a string');
      if (bytes === undefined || bytes === null) return { reply };
      if (!(bytes instanceof Uint8Array)) throw new Error('the reply buffer did not convert');
      // A copy, so the caller owns an exact ArrayBuffer and no Pyodide memory.
      return { reply, buffer: bytes.slice().buffer as ArrayBuffer };
    } finally {
      input?.destroy();
      output?.destroy();
    }
  };
}

// Loads the pinned Pyodide, installs PyMuPDF and the web package, and checks the engine with a
// hello call. Stages are reported in order: pyodide, packages, engine, ready.
export async function loadEngine(options: LoadOptions): Promise<EngineHandle> {
  const emit = options.onStage ?? (() => undefined);
  const importModule = options.importPyodide ?? defaultImport;
  const fetchBytes = options.fetchBytes ?? defaultFetch;
  const base = options.baseUrl;

  emit('pyodide');
  const pyodide = await attempt('pyodide', async () => {
    const module = await importModule(new URL('pyodide.mjs', base).href);
    return module.loadPyodide({ indexURL: new URL('./', base).href });
  });

  emit('packages');
  await attempt('packages', async () => {
    await pyodide.loadPackage(new URL(PYMUPDF_WHEEL_FILE, base).href);
    const zip = await fetchBytes(new URL(WEB_ZIP_FILE, base).href);
    pyodide.FS.writeFile(`/home/pyodide/${WEB_ZIP_FILE}`, new Uint8Array(zip));
    await pyodide.runPythonAsync(UNPACK_PY);
  });

  emit('engine');
  const dispatch = await attempt('engine', async () => {
    options.beforeEngine?.();
    await pyodide.runPythonAsync(ADAPTER_PY);
    const call = pyodide.globals.get('_pdfeditor_call');
    if (typeof call !== 'function') throw new Error('the engine adapter did not load');
    const dispatcher = makeDispatch(pyodide, call as PyCallable);
    const hello = JSON.parse(dispatcher(HELLO_REQUEST).reply) as {
      ok?: boolean;
      result?: { protocol?: number };
      error?: { message?: string };
    };
    if (hello.ok !== true || hello.result?.protocol !== WEBAPI_PROTOCOL) {
      throw new Error(`hello failed: ${hello.error?.message ?? 'protocol mismatch'}`);
    }
    return dispatcher;
  });

  emit('ready');
  return { dispatch };
}
