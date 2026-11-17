// W0.4 part 2 (spike-only, never imported by the app): the web set under Pyodide, in Node.
//
//   node audit/run_audit.mjs           (from web/spike, after audit/scan.py and the W0.1 prepare step)
//
// Uses the W0.1 runner's setup (dist/packages from `web/test/pyodide/run_engine_tests.mjs prepare`, the CDN pointed
// at a dead port, the repo mounted at /repo for fixtures) and loads the PyMuPDF wheel, fontTools
// and Pillow. numpy is not loaded: the app doesn't use it. audit.py does the work inside Pyodide.
//
// Two passes, each in a fresh Pyodide: "as-is" (the web zip exactly as scan.py built it), and
// "patched" (the same zip with the known blocker applied to the audit's copy, see audit.py), so
// the layers behind the blocker are measured too. Writes out/audit-runtime.json and
// out/audit-stdout.log. Exit status: 2 when the harness fails, including when a web module is
// missing from a pass's result (nothing is skipped silently). A failing import or check is a
// finding, recorded in the JSON, and exits 0.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(HERE, "..", "..");
const DIST = path.join(HERE, "dist");
const AUDIT_DIST = path.join(DIST, "audit");
const OUT = path.join(HERE, "out");
const PACKAGES = path.join(DIST, "packages");
const VERSIONS = JSON.parse(fs.readFileSync(path.join(HERE, "versions.json"), "utf8"));

function requireFile(file, hint) {
  if (!fs.existsSync(file)) throw new Error(`${file} missing: ${hint}`);
  return file;
}

// Same pin check as web/test/pyodide/run_engine_tests.mjs: the runtime must be the pinned one.
function checkPyodideVersion() {
  const declared = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  const installed = JSON.parse(
    fs.readFileSync(path.join(HERE, "node_modules", "pyodide", "package.json"), "utf8"),
  );
  for (const [where, version] of [
    ["package.json devDependencies.pyodide", declared.devDependencies?.pyodide],
    ["node_modules/pyodide", installed.version],
  ]) {
    if (version !== VERSIONS.pyodide) {
      throw new Error(`${where} is ${version}, versions.json says ${VERSIONS.pyodide}`);
    }
  }
}

// One pass in its own Pyodide. Returns the parsed result of audit.py. With `tiff` set, it runs
// only that TIFF compression (see audit.py) and the module rows are not checked.
async function runPass({ patch = false, tiff = null }, shared) {
  const { loadPyodide } = await import("pyodide");
  const log = [];
  const started = performance.now();
  const pyodide = await loadPyodide({
    packageCacheDir: PACKAGES,
    cdnUrl: "http://127.0.0.1:9/", // a package that isn't staged must fail, not be fetched
    stdout: (line) => log.push(line),
    stderr: (line) => log.push(line),
  });
  pyodide.FS.mkdirTree("/repo");
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: REPO }, "/repo");
  pyodide.FS.mkdirTree("/audit");
  pyodide.FS.writeFile("/audit/pdfeditor-web.zip", fs.readFileSync(shared.zip));
  pyodide.FS.writeFile("/audit/input.json", fs.readFileSync(shared.input));

  await pyodide.loadPackage(["fonttools", "pillow"]);
  // The wheel path is relative to the working directory (see web/test/pyodide/run_engine_tests.mjs).
  await pyodide.loadPackage(path.relative(process.cwd(), shared.wheel).split(path.sep).join("/"));
  const loadMs = Math.round(performance.now() - started);

  pyodide.globals.set("PATCH_PASS", patch);
  if (tiff) pyodide.globals.set("TIFF_PROBE", tiff);
  const label = tiff ? `tiff probe ${tiff}` : `patch=${patch}`;
  let raw;
  try {
    raw = await pyodide.runPythonAsync(shared.script);
  } finally {
    shared.log.push(`--- pass ${label} (Pyodide ${pyodide.version}) ---`, ...log);
  }
  const result = JSON.parse(raw);
  if (tiff) return { pyodideVersion: pyodide.version, loadMs, ...result };

  // Every web module must be in the result: one row per module the scan listed.
  const expected = shared.modules;
  const got = result.modules.map((row) => row.module);
  const missing = expected.filter((name) => !got.includes(name));
  if (missing.length > 0 || got.length !== expected.length) {
    throw new Error(
      `runtime result has ${got.length} module rows for ${expected.length} web modules; ` +
        `missing: ${missing.join(", ") || "(none, duplicates)"}`,
    );
  }
  return { pyodideVersion: pyodide.version, loadMs, ...result };
}

function sharedInputs() {
  const wheelInfo = JSON.parse(
    fs.readFileSync(requireFile(path.join(DIST, "wheel.json"), "run prepare first"), "utf8"),
  );
  const input = requireFile(path.join(AUDIT_DIST, "audit-input.json"), "run audit/scan.py first");
  return {
    wheelInfo,
    shared: {
      wheel: path.join(PACKAGES, wheelInfo.file),
      zip: requireFile(path.join(AUDIT_DIST, "pdfeditor-web.zip"), "run audit/scan.py first"),
      input,
      script: fs.readFileSync(path.join(HERE, "audit", "audit.py"), "utf8"),
      modules: JSON.parse(fs.readFileSync(input, "utf8")).modules,
      log: [],
    },
  };
}

// A TIFF probe runs in a child process: a libtiff abort takes the whole WebAssembly runtime
// down, and inside this process that is an unhandled rejection that ends the harness.
function runTiffProbe(sequence) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--tiff-probe", sequence], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (child.status === 0) {
    // Pyodide's loader also writes to stdout; the result is the last line.
    const last = child.stdout.trim().split("\n").at(-1);
    const result = JSON.parse(last);
    const written = result.steps.every((step) => step.result === "ok");
    return { ...result, status: written ? "ok" : "error" };
  }
  const lines = `${child.stderr ?? ""}`.split("\n").filter((line) => line.trim());
  const fatalLines = lines.filter((line) => /fatal|out of bounds|stack \(most recent/i.test(line));
  return {
    sequence,
    status: fatalLines.length > 0 ? "fatal" : "error",
    exitStatus: child.status,
    message: (lines.at(-1) ?? "no output").trim().slice(0, 300),
    // The fatal text is what the claim rests on, so keep it, with the trailer.
    fatalLines: fatalLines.slice(0, 10).map((line) => line.trim().slice(0, 300)),
    stderrTail: lines.slice(-10).map((line) => line.trim().slice(0, 300)),
  };
}

async function main() {
  checkPyodideVersion();
  const [flag, sequence] = process.argv.slice(2);
  if (flag === "--tiff-probe") {
    const { shared } = sharedInputs();
    const result = await runPass({ patch: true, tiff: sequence }, shared);
    process.stdout.write(JSON.stringify(result));
    return;
  }

  const { wheelInfo, shared } = sharedInputs();
  fs.mkdirSync(OUT, { recursive: true });

  const asIs = await runPass({ patch: false }, shared);
  const patched = await runPass({ patch: true }, shared);

  // Single compressions; (a) a failed deflate write, then LZW in the same runtime; (b) a
  // three-page LZW file rendered by the engine. Deflate must never be tried on the web.
  const probes = [];
  const sequences = [
    "raw",
    "tiff_lzw",
    "tiff_adobe_deflate",
    "tiff_deflate",
    "tiff_deflate+raw",
    "tiff_deflate+tiff_lzw",
    "multipage:tiff_lzw",
  ];
  for (const sequence of sequences) {
    probes.push(runTiffProbe(sequence));
  }
  fs.writeFileSync(path.join(OUT, "audit-stdout.log"), shared.log.join("\n") + "\n");

  const record = {
    pyodideLine: VERSIONS.pyodide,
    wheel: { file: wheelInfo.file, sha256: wheelInfo.sha256, bytes: wheelInfo.bytes },
    passes: { asIs, patched },
    tiffProbes: probes,
  };
  fs.writeFileSync(path.join(OUT, "audit-runtime.json"), JSON.stringify(record, null, 2));

  for (const [label, pass] of [
    ["as-is", asIs],
    ["patched", patched],
  ]) {
    const ok = pass.modules.filter((row) => row.status === "ok").length;
    console.log(
      `${label}: ${ok}/${pass.modules.length} web modules import; failures ` +
        `${JSON.stringify(pass.moduleFailuresByCategory)}; checks ${pass.checksPassed}/${pass.checks.length} pass`,
    );
  }
  console.log(
    `Pyodide ${asIs.pyodideVersion}, PyMuPDF ${asIs.pymupdf}, MuPDF ${asIs.mupdf}`,
  );
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(2);
}
