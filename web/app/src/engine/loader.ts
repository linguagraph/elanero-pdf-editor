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
  // The page's ImageBitmap, when the worker made one (W5.1b S5); see ReplyMessage.bitmap.
  bitmap?: ImageBitmap;
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
    onNotice?: (notice: Notice, buffer?: ArrayBuffer) => void,
  ): CallResult;
  // Installs fontTools the first time a text edit needs it (W6.8a). Resolves in every case: without
  // fontTools the edit still runs, with a degraded character map, so a failure only logs a warning.
  ensureFontTools?(): Promise<void>;
}

export type LoadEngine = (options: LoadOptions) => Promise<EngineHandle>;

// The Pyodide package the engine imports at module level (see scripts/stage_engine_assets.mjs).
export const PILLOW_PACKAGE = 'pillow';

// fontTools (W6.8a). Pyodide's pure-Python wheel is staged next to the engine (scripts/
// stage_engine_assets.mjs). Its bytes are read before the network lock, then installed by
// FONTTOOLS_INSTALL_PY on the first text edit. A lock bump must change this name with the lock.
export const FONTTOOLS_WHEEL_FILE = 'fonttools-4.62.1-py3-none-any.whl';
const FONTTOOLS_WHEEL_PATH = `/home/pyodide/${FONTTOOLS_WHEEL_FILE}`;

// The requests that need fontTools: the text edits, whose ToUnicode and glyph checks read it.
const FONTTOOLS_ACTIONS = new Set(['content.replace_text', 'content.add_text']);

// True when a request is an action that needs fontTools, so the worker installs it first.
export function needsFontTools(request: string): boolean {
  try {
    const parsed = JSON.parse(request) as { method?: unknown; params?: { name?: unknown } };
    return (
      parsed.method === 'actions.run' &&
      typeof parsed.params?.name === 'string' &&
      FONTTOOLS_ACTIONS.has(parsed.params.name)
    );
  } catch {
    return false;
  }
}

// Unzips the staged wheel into site-packages (it is pure Python, so no Pyodide package load, which
// would need fetch, is required) and checks that fontTools imports.
const FONTTOOLS_INSTALL_PY = `
import importlib, os, sysconfig, zipfile
wheel = "${FONTTOOLS_WHEEL_PATH}"
with zipfile.ZipFile(wheel) as archive:
    archive.extractall(sysconfig.get_paths()["purelib"])
os.remove(wheel)
importlib.invalidate_caches()
import fontTools.ttLib
`;

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
// each notice to the JS side as JSON text, which the caller parses. A partial notice (W6.5) also
// carries its buffer, as a view the JS side copies at once; a progress notice carries none. Its
// reply carries the whole list of result buffers, so a split can return one file per part.
const JOB_ADAPTER_PY = `
import json as _json
from pdfeditor.webapi import jobworker as _jobworker

def _pdfeditor_job_call(request, joined, sizes, on_notice):
    buffers = []
    if joined is not None:
        # Each slice is copied once, from a view, so the request's bytes are not copied first.
        view = memoryview(joined)
        start = 0
        for size in sizes:
            end = start + int(size)
            buffers.append(bytes(view[start:end]))
            start = end
    def notify(notice):
        on_notice(_json.dumps(notice, allow_nan=False, separators=(",", ":")), None)
    def partial(notice, out):
        on_notice(_json.dumps(notice, allow_nan=False, separators=(",", ":")), memoryview(out[0]))
    reply, out = _jobworker.dispatch(request, buffers, notify, None, partial)
    return reply, [memoryview(data) for data in out]
`;

const HELLO_REQUEST = JSON.stringify({ v: WEBAPI_PROTOCOL, id: 1, method: 'hello', params: {} });

type PyCallable = (
  request: string,
  joined: PyProxyLike | undefined,
  sizes: PyProxyLike,
  onNotice?: (text: string, data?: PyProxyLike | null) => void,
) => unknown;

// pyodide.mjs decides at evaluation time whether it runs in a classic worker by calling
// globalThis.importScripts("data:text/javascript,") inside a try/catch. That call is a
// string-to-script sink, so under the page's require-trusted-types-for 'script' (csp.ts) Firefox
// and WebKit report a CSP violation for it. The probe still answers "not classic" (a module worker
// has no importScripts that works), so the engine loads either way; the violation was log noise
// that fails the CSP checks. Hiding importScripts for the evaluation makes the probe's call fail
// on its own, with the same answer and no sink. No Trusted Types policy is needed, so the CSP is
// not loosened. The function is put back afterwards.
export async function withoutImportScripts<T>(run: () => Promise<T>): Promise<T> {
  const scope = globalThis as { importScripts?: unknown };
  const had = 'importScripts' in scope;
  const saved = scope.importScripts;
  scope.importScripts = undefined;
  try {
    return await run();
  } finally {
    if (had) scope.importScripts = saved;
    else delete scope.importScripts;
  }
}

const defaultImport = (url: string): Promise<PyodideModule> =>
  withoutImportScripts(() => import(/* @vite-ignore */ url) as Promise<PyodideModule>);

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
        ? (text: string, data?: PyProxyLike | null) => {
            const notice = parseNotice(text);
            if (notice === undefined) return;
            // A partial's buffer is copied out of the wasm heap here, and its proxy freed at once.
            if (data === undefined || data === null) {
              onNotice?.(notice);
              return;
            }
            const view = asProxy(data);
            try {
              onNotice?.(notice, copyBytes(view.toJs()));
            } finally {
              view.destroy();
            }
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

  const isJob = options.role === 'job';
  // Set once the fontTools wheel is in the Pyodide file system (before the network lock).
  let fontWheelStaged = false;
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
    if (!isJob) {
      // Best effort: without the wheel, text edits still run (see ensureFontTools).
      try {
        const wheel = await fetchBytes(new URL(FONTTOOLS_WHEEL_FILE, base).href);
        pyodide.FS.writeFile(FONTTOOLS_WHEEL_PATH, new Uint8Array(wheel));
        fontWheelStaged = true;
      } catch (error) {
        console.warn(`fontTools wheel not staged: ${messageOf(error)}`);
      }
    }
  });

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

  // Memoized: the first text edit installs fontTools, later ones reuse the result (a failure too,
  // so a broken install is not retried on every edit).
  let fontTools: Promise<void> | undefined;
  const ensureFontTools = (): Promise<void> => {
    if (fontTools === undefined) {
      // A wheel that was not staged was already reported by the packages stage: nothing to add.
      const install = fontWheelStaged
        ? pyodide.runPythonAsync(FONTTOOLS_INSTALL_PY).then(() => undefined)
        : Promise.resolve();
      fontTools = install.catch((error: unknown) => {
        console.warn(
          `fontTools did not load; text edits keep a degraded character map: ${messageOf(error)}`,
        );
      });
    }
    return fontTools;
  };

  emit('ready');
  return { dispatch, ensureFontTools: isJob ? undefined : ensureFontTools };
}
