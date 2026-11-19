// W3.1 slice 3: Pyodide memory-snapshot probe (spike only; never imported by the app).
//
//   node web/spike/snapshot_probe.mjs            # full study: make snapshots, then 5 runs per path
//   node web/spike/snapshot_probe.mjs make       # only make the snapshots (dist/snapshots/)
//   node web/spike/snapshot_probe.mjs run <cold|restore0> [open]   # one child run
//
// It drives the engine the way web/app/src/engine/loader.ts does: Pillow, the PyMuPDF wheel, the
// web zip, the adapter, then hello. Inputs are the staged engine assets (web/spike/dist/engine-assets,
// copied from web/app/public/engine-assets) and tests/fixtures/generated/perf_mixed_10.pdf. Each
// measured run is its own Node process, so RSS and wasm heap are not shared between runs.
//
// Snapshot variants (each is tried; the make step records which ones Pyodide accepts):
//   core      taken right after loadPyodide, nothing else loaded
//   packages  taken after pillow and the PyMuPDF wheel are installed (loadPackage)
//   pymupdf   taken after `import pymupdf`, the web zip unpacked and the adapter imported
// Only a snapshot that is made is restored. restore0 loads core.snap and then does the rest of the
// engine load (packages, import, unzip, adapter, hello) exactly as the cold path does.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ENGINE = path.join(HERE, "dist", "engine-assets");
const SNAPDIR = path.join(HERE, "dist", "snapshots");
const FIXTURE = path.join(REPO, "tests", "fixtures", "generated", "perf_mixed_10.pdf");
const RESULTS = path.join(HERE, "dist", "snapshot-results.json");
const WHEEL = "pymupdf-1.28.2-cp313-abi3-pyemscripten_2025_0_wasm32.whl";
const WEB_ZIP = "pdfeditor-web.zip";
const RUNS = 5;

// Pyodide's loadPackage names a .whl from its bare file name, relative to the working directory:
// an absolute path or a file:// URL gives a wrong dist-info name, or an ENOENT under Node on Windows.
process.chdir(ENGINE);

// The same Python the app runs (loader.ts UNPACK_PY and ADAPTER_PY).
const UNPACK_PY = `
import os, sys, zipfile
zip_path = "/home/pyodide/${WEB_ZIP}"
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall("/home/pyodide")
os.remove(zip_path)
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
`;
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

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const now = () => performance.now();
const round = (n) => Math.round(n * 10) / 10;
const mib = (n) => Math.round((n / 1048576) * 100) / 100;

async function importPyodide() {
  const mod = await import(pathToFileURL(path.join(ENGINE, "pyodide.mjs")).href);
  return mod.loadPyodide;
}

// Pyodide options as the browser loader passes them, with the CDN blocked (anything unstaged fails).
function baseOptions(extra) {
  const errors = [];
  return {
    opts: {
      indexURL: ENGINE + path.sep,
      packageBaseUrl: ENGINE + path.sep,
      lockFileURL: path.join(ENGINE, "pyodide-lock.json"),
      cdnUrl: "http://127.0.0.1:9/",
      stdout: () => {},
      stderr: (line) => errors.push(line),
      ...extra,
    },
    errors,
  };
}

async function installPackages(py, marks) {
  const t = now();
  await py.loadPackage("pillow");
  await py.loadPackage(WHEEL);
  marks.packages = round(now() - t);
}

async function importEngine(py, marks) {
  let t = now();
  await py.runPythonAsync("import pymupdf");
  marks.import_pymupdf = round(now() - t);
  t = now();
  py.FS.writeFile(`/home/pyodide/${WEB_ZIP}`, new Uint8Array(fs.readFileSync(path.join(ENGINE, WEB_ZIP))));
  await py.runPythonAsync(UNPACK_PY);
  marks.unzip = round(now() - t);
  t = now();
  await py.runPythonAsync(ADAPTER_PY);
  marks.adapter = round(now() - t);
  return py.globals.get("_pdfeditor_call");
}

// One RPC round trip, in the same shape as loader.ts makeDispatch.
function makeDispatch(py, call) {
  return (request, buffers = []) => {
    let joined;
    if (buffers.length === 1) joined = buffers[0];
    else if (buffers.length > 1) {
      const total = buffers.reduce((n, b) => n + b.byteLength, 0);
      joined = new Uint8Array(total);
      let off = 0;
      for (const b of buffers) {
        joined.set(b, off);
        off += b.byteLength;
      }
    }
    const input = joined === undefined ? undefined : py.toPy(joined);
    const sizes = py.toPy(buffers.map((b) => b.byteLength));
    const out = call(JSON.stringify(request), input, sizes);
    const [reply, bytes] = out.toJs();
    out.destroy();
    input?.destroy();
    sizes.destroy();
    return { reply: JSON.parse(reply), buffer: bytes ? new Uint8Array(bytes).slice() : undefined };
  };
}

let nextId = 1;
function rpc(dispatch, method, params, buffers) {
  const res = dispatch({ v: 1, id: nextId++, method, params }, buffers);
  if (!res.reply.ok) throw new Error(`${method}: ${JSON.stringify(res.reply.error)}`);
  return res;
}

const heapBytes = (py) => py._module.HEAP8.buffer.byteLength;

// Hello, open the fixture, render page 0, save (copy), reopen the saved bytes. Returns the checks.
function exercise(dispatch) {
  const out = { steps: {} };
  let t = now();
  rpc(dispatch, "hello", {});
  out.steps.hello = round(now() - t);

  const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  t = now();
  const opened = rpc(dispatch, "session.open", { name: "perf_mixed_10.pdf", data: { $bin: 0 }, password: null }, [bytes]);
  out.steps.open = round(now() - t);
  const handle = opened.reply.result.handle;
  out.pages = opened.reply.result.pages;

  t = now();
  let revision = 0;
  let image;
  for (let attempt = 0; attempt < 3; attempt++) {
    image = rpc(dispatch, "render.page", { handle, page: 0, revision, scale_milli: 1000, rotation: 0, annotations: false });
    if (image.reply.result.width > 0) break;
    revision = image.reply.result.revision;
  }
  out.steps.render_page0 = round(now() - t);
  out.render = { width: image.reply.result.width, height: image.reply.result.height, sha: sha(image.buffer) };

  t = now();
  const saved = rpc(dispatch, "save.save_bytes", { handle, mode: "copy" });
  out.steps.save = round(now() - t);
  out.saved = { size: saved.buffer.byteLength, sha: sha(saved.buffer) };

  const reopened = rpc(dispatch, "session.open", { name: "saved.pdf", data: { $bin: 0 }, password: null }, [saved.buffer]);
  out.reopen_pages = reopened.reply.result.pages;
  return out;
}

// ---- snapshot making ------------------------------------------------------

async function makeSnapshot(variant) {
  const loadPyodide = await importPyodide();
  const { opts, errors } = baseOptions({ _makeSnapshot: true });
  const marks = {};
  const py = await loadPyodide(opts);
  if (variant !== "core") await installPackages(py, marks);
  if (variant === "pymupdf") {
    const call = await importEngine(py, marks);
    if (typeof call !== "function") throw new Error("adapter did not load");
  }
  const t = now();
  const snap = py.makeMemorySnapshot();
  return { bytes: snap, makeMs: round(now() - t), marks, errors: errors.slice(-5) };
}

async function makeAll() {
  fs.mkdirSync(SNAPDIR, { recursive: true });
  const out = {};
  for (const variant of ["core", "packages", "pymupdf"]) {
    try {
      const made = await makeSnapshot(variant);
      fs.writeFileSync(path.join(SNAPDIR, `${variant}.snap`), made.bytes);
      const gz = zlib.gzipSync(made.bytes, { level: 9 });
      out[variant] = {
        ok: true,
        rawBytes: made.bytes.byteLength,
        rawMiB: mib(made.bytes.byteLength),
        gzipBytes: gz.byteLength,
        gzipMiB: mib(gz.byteLength),
        makeMs: made.makeMs,
        marks: made.marks,
        errors: made.errors,
      };
    } catch (err) {
      // A failed variant must not leave an old file behind for a restore to pick up.
      fs.rmSync(path.join(SNAPDIR, `${variant}.snap`), { force: true });
      out[variant] = { ok: false, error: String(err.message ?? err) };
    }
  }
  return out;
}

// ---- one measured run (child process) -------------------------------------

async function childRun(mode, withOpen) {
  const loadPyodide = await importPyodide();
  const marks = {};
  const t0 = now();
  let py;
  let call;
  let loadError = null;
  if (mode === "cold") {
    const { opts, errors } = baseOptions({});
    py = await loadPyodide(opts);
    marks.loadPyodide = round(now() - t0);
    await installPackages(py, marks);
    call = await importEngine(py, marks);
    marks.pyodide_errors = errors.slice(-3);
  } else {
    const bytes = new Uint8Array(fs.readFileSync(path.join(SNAPDIR, "core.snap")));
    const { opts, errors } = baseOptions({ _loadSnapshot: bytes });
    try {
      py = await loadPyodide(opts);
      marks.restore = round(now() - t0);
      await installPackages(py, marks);
      call = await importEngine(py, marks);
      marks.pyodide_errors = errors.slice(-3);
    } catch (err) {
      loadError = String(err && err.message ? err.message : err);
    }
  }
  if (!py || typeof call !== "function") {
    return { mode, ok: false, error: loadError ?? "no adapter after load", marks };
  }
  const dispatch = makeDispatch(py, call);
  const readyMs = round(now() - t0);
  const wasmHeapMiB = mib(heapBytes(py));
  const rssMiB = mib(process.memoryUsage().rss);
  let ok = true;
  let openRenderMs = null;
  let check = null;
  try {
    if (withOpen) {
      const t = now();
      check = exercise(dispatch);
      openRenderMs = round(now() - t);
    } else {
      rpc(dispatch, "hello", {});
    }
  } catch (err) {
    ok = false;
    check = { error: String(err.message ?? err) };
  }
  return { mode, ok, readyMs, openRenderMs, wasmHeapMiB, rssMiB, marks, check };
}

// ---- orchestration --------------------------------------------------------

function child(args) {
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout || "").split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) return { ok: false, error: `exit ${res.status}: ${(res.stderr || "").slice(-800)}` };
  return JSON.parse(line.slice(7));
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

async function orchestrate() {
  const snapshots = await makeAll();
  const results = { node: process.version, snapshots, runs: {}, summary: {} };
  const plan = [
    ["cold", false],
    ["cold", true],
    ["restore0", false],
    ["restore0", true],
  ];
  if (fs.existsSync(path.join(SNAPDIR, "core.snap"))) {
    for (const [mode, open] of plan) {
      const key = open ? `${mode}+open` : mode;
      results.runs[key] = [];
      for (let i = 0; i < RUNS; i++) {
        results.runs[key].push(child(["run", mode, ...(open ? ["open"] : [])]));
      }
    }
  }
  for (const [key, runs] of Object.entries(results.runs)) {
    const good = runs.filter((r) => r.ok);
    const bad = runs.find((r) => !r.ok);
    results.summary[key] = {
      okRuns: `${good.length}/${runs.length}`,
      readyMedian: good.length ? round(median(good.map((r) => r.readyMs))) : null,
      openRenderMedian:
        good.length && good[0].openRenderMs != null ? round(median(good.map((r) => r.openRenderMs))) : null,
      wasmHeapMiB: good[0]?.wasmHeapMiB ?? null,
      rssMiBMedian: good.length ? round(median(good.map((r) => r.rssMiB))) : null,
      firstError: bad ? bad.error ?? bad.check?.error ?? "unknown" : null,
      lastCheck: good.length ? good[good.length - 1].check : null,
    };
  }
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ snapshots, summary: results.summary }, null, 2));
  console.log(`wrote ${RESULTS}`);
}

const [cmd, mode, flag] = process.argv.slice(2);
if (cmd === "run") {
  console.log("RESULT " + JSON.stringify(await childRun(mode, flag === "open")));
} else if (cmd === "make") {
  console.log(JSON.stringify(await makeAll(), null, 2));
} else {
  await orchestrate();
}
