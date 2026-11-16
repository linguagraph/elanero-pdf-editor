// W0.1 browser smoke worker (spike only). Runs the engine the way Elanero Web will: Pyodide in a
// Web Worker, on the page's own origin, with no SharedArrayBuffer. Everything is fetched from
// this server (node_modules/pyodide, dist/); nothing comes from a CDN at test time.

import { loadPyodide } from "../node_modules/pyodide/pyodide.mjs";

const ROOT = new URL("../", import.meta.url); // web/spike/
const started = performance.now();
const log = [];

const post = (msg, transfer = []) => self.postMessage(msg, transfer);
const progress = (text) => {
  log.push(text);
  post({ type: "progress", text });
};

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchText(relative) {
  const res = await fetch(new URL(relative, ROOT));
  if (!res.ok) throw new Error(`GET ${relative}: HTTP ${res.status}`);
  return res.text();
}

async function fetchJson(relative) {
  return JSON.parse(await fetchText(relative));
}

async function main() {
  const versions = await fetchJson("versions.json");
  const wheel = await fetchJson("dist/wheel.json");
  const manifest = await fetchJson("dist/src-manifest.json");

  const t0 = performance.now();
  const pyodide = await loadPyodide({
    indexURL: new URL("node_modules/pyodide/", ROOT).href,
    packageBaseUrl: new URL("dist/packages/", ROOT).href,
    lockFileURL: new URL("dist/packages/pyodide-lock.json", ROOT).href,
    // Anything not staged fails here instead of being fetched from the CDN.
    cdnUrl: "http://127.0.0.1:9/",
    stdout: progress,
    stderr: (line) => progress(`stderr: ${line}`),
  });
  progress(`Pyodide ${pyodide.version} ready`);

  await pyodide.loadPackage(versions.packageRoots);
  await pyodide.loadPackage(new URL(`dist/packages/${wheel.file}`, ROOT).href);
  const loadMs = Math.round(performance.now() - t0);

  // The pdfeditor engine, model and core sources, copied into the Pyodide file system.
  const sources = await Promise.all(
    manifest.map(async (rel) => [rel, await fetchText(`dist/src/${rel}`)]),
  );
  for (const [rel, text] of sources) {
    const target = `/pdfsrc/${rel}`;
    const dir = target.slice(0, target.lastIndexOf("/"));
    pyodide.FS.mkdirTree(dir);
    pyodide.FS.writeFile(target, text);
  }
  pyodide.FS.writeFile("/tmp/input.pdf", new Uint8Array(await (await fetch(new URL("dist/input.pdf", ROOT))).arrayBuffer()));
  pyodide.runPython("import sys\nsys.path.insert(0, '/pdfsrc')\n");

  const smokeSource = await fetchText("smoke/smoke.py");
  pyodide.runPython(smokeSource);
  const runSmoke = pyodide.globals.get("run");

  const t1 = performance.now();
  const result = JSON.parse(runSmoke("/tmp/input.pdf", "/tmp/out.pdf"));
  const smokeMs = Math.round(performance.now() - t1);

  let saved = null;
  if (pyodide.FS.analyzePath("/tmp/out.pdf").exists) {
    saved = pyodide.FS.readFile("/tmp/out.pdf");
  }
  post(
    {
      type: "done",
      result,
      sources: sources.length,
      savedBase64: saved ? bytesToBase64(saved) : null,
      savedBytes: saved ? saved.length : 0,
      timings: { loadMs, smokeMs, totalMs: Math.round(performance.now() - started) },
      pyodideVersion: pyodide.version,
      heapBytes: pyodide._module.HEAPU8.length,
      crossOriginIsolated: self.crossOriginIsolated === true,
      wheel: wheel.file,
      log: log.slice(-200),
    },
    [],
  );
}

main().catch((err) => {
  post({
    type: "error",
    message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    stack: err instanceof Error ? (err.stack ?? "") : "",
    log: log.slice(-200),
  });
});
