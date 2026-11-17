// W0.2 perf worker (spike-only). One worker per engine: "engine" (the main document) or "job"
// (the disposable job worker of M4). Both boot the same way: Pyodide, the full package set, the
// PyMuPDF wheel, the trimmed pdfeditor zip, then the engine. The main thread (index.html) drives
// every operation by message; each reply carries the worker's clock (`t`) so the phases line up.
//
// No SharedArrayBuffer and no CDN: everything comes from this server (web/spike/dist, node_modules).

import { loadPyodide } from "../node_modules/pyodide/pyodide.mjs";

const ROOT = new URL("../", import.meta.url); // web/spike/
const abs = () => performance.timeOrigin + performance.now();
const marks = [];
const log = [];
const mark = (name) => {
  const t = abs();
  marks.push({ name, t });
  self.postMessage({ type: "mark", name, t });
};

let pyodide = null;
let perf = null;

async function fetchBytes(relative) {
  const res = await fetch(new URL(relative, ROOT));
  if (!res.ok) throw new Error(`GET ${relative}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchJson(relative) {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(relative)));
}

const heapBytes = () => pyodide._module.HEAP8.buffer.byteLength;

// Resource entries the worker fetched (Pyodide core, wheel, zip, packages): the cross-check for M1.
function resources() {
  return performance.getEntriesByType("resource").map((e) => ({
    name: e.name.split("/").pop(),
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    decodedBodySize: e.decodedBodySize,
  }));
}

async function boot() {
  mark("worker-started");
  const wheel = await fetchJson("dist/perf/wheel.json");
  const packages = await fetchJson("dist/perf/packages.json");

  pyodide = await loadPyodide({
    indexURL: new URL("node_modules/pyodide/", ROOT).href,
    packageBaseUrl: new URL("dist/packages/", ROOT).href,
    lockFileURL: new URL("dist/packages/pyodide-lock.json", ROOT).href,
    // Anything not staged fails here instead of being fetched from the CDN.
    cdnUrl: "http://127.0.0.1:9/",
    stdout: (line) => log.push(line),
    stderr: (line) => log.push(`stderr: ${line}`),
  });
  mark("pyodide-ready");

  await pyodide.loadPackage(packages);
  mark("packages-loaded");

  await pyodide.loadPackage(new URL(`dist/packages/${wheel.file}`, ROOT).href);
  mark("wheel-loaded");

  pyodide.FS.writeFile("/pdfeditor-web.zip", await fetchBytes("dist/perf/pdfeditor-web.zip"));
  pyodide.FS.mkdirTree("/perfmod");
  pyodide.FS.writeFile("/perfmod/perf.py", await fetchBytes("perf/perf.py"));
  pyodide.runPython("import sys\nsys.path.insert(0, '/perfmod')\n");
  perf = pyodide.pyimport("perf");
  mark("harness-loaded");

  JSON.parse(perf.import_pdfeditor("/pdfeditor-web.zip"));
  mark("pdfeditor-imported");

  JSON.parse(perf.engine_ready());
  mark("engine-ready");
}

const booted = boot()
  .then(() => true)
  .catch((err) => {
  self.postMessage({
    type: "fatal",
    message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    stack: err instanceof Error ? (err.stack ?? "") : "",
    log: log.slice(-100),
    });
    return false;
  });

// Runs one Python call; errors are returned to the main thread rather than thrown into it.
function py(fn) {
  return JSON.parse(fn());
}

async function handle(op, args) {
  if (!(await booted) || !perf) throw new Error("the worker did not boot");
  switch (op) {
    case "ready":
      return {
        marks,
        resources: resources(),
        pyodide: pyodide.version,
        heapBytes: heapBytes(),
        python: pyodide.runPython("import sys; sys.version.split()[0]"),
      };
    case "open": {
      pyodide.FS.writeFile("/doc.pdf", args.bytes);
      const out = py(() => perf.open_doc("/doc.pdf"));
      return { ...out, heapBytes: heapBytes() };
    }
    case "render": {
      const out = py(() => perf.render(args.index, args.scale, "/render.bin"));
      const pyDone = abs();
      const width = out.width;
      const height = out.height;
      const samples = pyodide.FS.readFile("/render.bin");
      const pixels = new ImageData(new Uint8ClampedArray(samples.buffer, 0, samples.length), width, height);
      const bitmap = await createImageBitmap(pixels);
      return { data: { ...out, pyDone, bitmap, bitmapBytes: samples.length } };
    }
    case "text":
      return py(() => perf.text_page(args.index));
    case "search":
      return py(() => perf.search(args.needle));
    case "plan":
      return py(() => perf.plan_pages(args.count));
    case "save":
      return { ...py(() => perf.save()), heapBytes: heapBytes() };
    case "close": {
      const out = py(() => perf.close());
      return { ...out, heapBytes: heapBytes() };
    }
    case "heap":
      return { heapBytes: heapBytes() };
    default:
      throw new Error(`unknown op ${op}`);
  }
}

self.onmessage = async (event) => {
  const { id, op, args } = event.data;
  try {
    const out = await handle(op, args ?? {});
    if (out && out.data && out.data.bitmap) {
      const bitmap = out.data.bitmap;
      out.data.sentAbs = abs();
      self.postMessage({ id, ok: true, t: out.data.sentAbs, data: out.data }, [bitmap]);
      return;
    }
    self.postMessage({ id, ok: true, t: abs(), data: out });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      t: abs(),
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? (err.stack ?? "") : "",
    });
  }
};
