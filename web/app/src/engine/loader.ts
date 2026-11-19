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
  // Which Python entry point answers: the engine's (default) or the job worker's (job.run, W3.7).
  role?: WorkerRole;
  onStage?: (stage: Stage) => void;
  // Runs after the packages are in place and before any engine code runs. The job worker
  // removes its network globals here: Pyodide itself still needs fetch to load packages.
  beforeEngine?: () => void;
  importPyodide?: (url: string) => Promise<PyodideModule>;
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
}

export interface CallResult {
  reply: string;
  // The engine's reply carries one buffer at most. A job worker's reply carries a list, in the
  // order its $bin markers name them (W1.2 section 5).
  buffer?: ArrayBuffer;
  buffers?: ArrayBuffer[];
}

// A notice the worker sends while a call runs, such as a job's progress (W1.2 section 8). Only the
// job worker sends them.
export type Notice = Record<string, unknown>;

export type WorkerRole = 'engine' | 'job';

export interface EngineHandle {
  // The request's binary values, in $bin order, and the reply's one buffer (if any). A job worker
  // also gets each notice of the call, in order, before the reply.
  dispatch(
    request: string,
    buffers?: readonly ArrayBuffer[],
    onNotice?: (notice: Notice) => void,
  ): CallResult;
}

export type LoadEngine = (options: LoadOptions) => Promise<EngineHandle>;

// The Pyodide package the engine imports at module level (see scripts/stage_engine_assets.mjs).
export const PILLOW_PACKAGE = 'pillow';

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

// Python run once before the first call. It holds the only function the JS side calls: the
// request's binary values in, at most one buffer out. The values travel joined in one buffer, and
// `sizes` gives each one's length, so the adapter can split them back apart.
const ADAPTER_PY = `
from pdfeditor.webapi import dispatch as _dispatch

def _pdfeditor_call(request, joined, sizes):
    buffers = []
    if joined is not None:
        raw = bytes(joined)
        start = 0
        for size in sizes:
            buffers.append(raw[start:start + int(size)])
            start += int(size)
    reply, out = _dispatch(request, buffers)
    if len(out) > 1:
        raise ValueError("a reply carries at most one buffer")
    return reply, (memoryview(out[0]) if out else None)
`;

// The job worker's adapter (W3.7). It answers job.run through the job worker's own table, and hands
// each progress notice to the JS side as JSON text, which the caller parses. Its reply carries the
// whole list of result buffers, so a split can return one file per part.
const JOB_ADAPTER_PY = `
import json as _json
from pdfeditor.webapi import jobworker as _jobworker

def _pdfeditor_job_call(request, joined, sizes, on_notice):
    buffers = []
    if joined is not None:
        raw = bytes(joined)
        start = 0
        for size in sizes:
            buffers.append(raw[start:start + int(size)])
            start += int(size)
    def notify(notice):
        on_notice(_json.dumps(notice, allow_nan=False, separators=(",", ":")))
    reply, out = _jobworker.dispatch(request, buffers, notify)
    return reply, [memoryview(data) for data in out]
`;

const HELLO_REQUEST = JSON.stringify({ v: WEBAPI_PROTOCOL, id: 1, method: 'hello', params: {} });

type PyCallable = (
  request: string,
  joined: PyProxyLike | undefined,
  sizes: PyProxyLike,
  onNotice?: (text: string) => void,
) => unknown;

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

// Parses one notice the job worker wrote as JSON. A notice that is not an object is dropped: it is
// progress for the bar only, so it must never fail the call.
function parseNotice(text: string): Notice | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Notice)
      : undefined;
  } catch {
    return undefined;
  }
}

function makeDispatch(
  pyodide: PyodideLike,
  call: PyCallable,
  withNotices: boolean,
): EngineHandle['dispatch'] {
  return (request, buffers = [], onNotice) => {
    let input: PyProxyLike | undefined;
    let sizes: PyProxyLike | undefined;
    let output: PyProxyLike | undefined;
    try {
      const joined = joinBuffers(buffers);
      input = joined === undefined ? undefined : pyodide.toPy(joined);
      sizes = pyodide.toPy(buffers.map((buffer) => buffer.byteLength));
      const notify = withNotices
        ? (text: string) => {
            const notice = parseNotice(text);
            if (notice !== undefined) onNotice?.(notice);
          }
        : undefined;
      // The engine's adapter takes three arguments; only the job adapter takes the notice callback.
      output = asProxy(
        notify === undefined ? call(request, input, sizes) : call(request, input, sizes, notify),
      );
      const [reply, bytes] = output.toJs() as [unknown, unknown];
      if (typeof reply !== 'string') throw new Error('the reply is not a string');
      if (bytes === undefined || bytes === null) return { reply };
      // The job adapter returns a list of buffers; the engine returns one or none.
      if (Array.isArray(bytes)) {
        // The first buffer is also `buffer`, so a reader of one document still finds it.
        const list = bytes.map((item) => copyBytes(item));
        return list.length === 0 ? { reply } : { reply, buffer: list[0], buffers: list };
      }
      return { reply, buffer: copyBytes(bytes) };
    } finally {
      input?.destroy();
      sizes?.destroy();
      output?.destroy();
    }
  };
}

// A copy of one reply buffer, so the caller owns an exact ArrayBuffer and no Pyodide memory.
function copyBytes(value: unknown): ArrayBuffer {
  if (!(value instanceof Uint8Array)) throw new Error('the reply buffer did not convert');
  return value.slice().buffer as ArrayBuffer;
}

// The request's binary values as one buffer, or undefined when there are none. A copy is made only
// when there is more than one value; a single one is passed as it is.
function joinBuffers(buffers: readonly ArrayBuffer[]): Uint8Array | undefined {
  if (buffers.length === 0) return undefined;
  if (buffers.length === 1) return new Uint8Array(buffers[0] as ArrayBuffer);
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    joined.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return joined;
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
    // Pillow is a Pyodide package, not part of the wheel: the engine imports it at module level,
    // so it is named here and resolved from the staged pyodide-lock.json (same folder as Pyodide).
    await pyodide.loadPackage(PILLOW_PACKAGE);
    await pyodide.loadPackage(new URL(PYMUPDF_WHEEL_FILE, base).href);
    // Pyodide logs a wheel it cannot fetch and still resolves, so the import is the real check
    // that PyMuPDF arrived. The engine's hello alone would pass without it.
    await pyodide.runPythonAsync('import pymupdf');
    const zip = await fetchBytes(new URL(WEB_ZIP_FILE, base).href);
    pyodide.FS.writeFile(`/home/pyodide/${WEB_ZIP_FILE}`, new Uint8Array(zip));
    await pyodide.runPythonAsync(UNPACK_PY);
  });

  const isJob = options.role === 'job';
  emit('engine');
  const dispatch = await attempt('engine', async () => {
    options.beforeEngine?.();
    await pyodide.runPythonAsync(isJob ? JOB_ADAPTER_PY : ADAPTER_PY);
    const call = pyodide.globals.get(isJob ? '_pdfeditor_job_call' : '_pdfeditor_call');
    if (typeof call !== 'function') throw new Error('the adapter did not load');
    const dispatcher = makeDispatch(pyodide, call as PyCallable, isJob);
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
