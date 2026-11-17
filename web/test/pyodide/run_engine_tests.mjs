// W0.1 spike (spike-only, never imported by the app).
//
//   node web/test/pyodide/run_engine_tests.mjs prepare --wheel <pymupdf-wasm.whl>
//
// Moved here from web/spike in W2.7a. The spike's inputs and outputs stay under web/spike (dist/,
// out/, versions.json, node_modules/), so the spike's audit, perf and smoke tooling is unchanged.
//       Stages what both test runs need under web/spike/dist/: the PyMuPDF wheel (dist/packages),
//       the Pyodide package closure (the only network use in the spike; each file is checked against the
//       sha256 in pyodide-lock.json), the generated fixture the browser smoke test opens, and the
//       pdfeditor sources the browser worker imports.
//   node web/test/pyodide/run_engine_tests.mjs run
//       Runs tests/engine under Pyodide in Node. Nothing is fetched at this point: packages come
//       from dist/packages, and the CDN is pointed at a dead port so a missing file fails loudly.
//
// Exit status: 2 when the harness itself fails. A failing engine test still exits 0 (the results
// are the output; the go/no-go gate is docs/web/spikes/W0.1-results.md).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
// The spike folder: its versions.json, package.json and node_modules are the single source.
const SPIKE = path.resolve(HERE, "..", "..", "spike");
const DIST = path.join(SPIKE, "dist");
const OUT = path.join(SPIKE, "out");
const PACKAGES = path.join(DIST, "packages");
const VERSIONS = JSON.parse(fs.readFileSync(path.join(SPIKE, "versions.json"), "utf8"));
const CDN = `https://cdn.jsdelivr.net/pyodide/v${VERSIONS.pyodide}/full/`;
const FIXTURE = "text_multipage.pdf";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// versions.json is the single source. package.json pins the same Pyodide version (the npm
// package supplies the runtime and the lockfile), so both must be bumped together: this check
// fails when they drift, and when the installed package is not the pinned one.
function checkPyodideVersion() {
  const declared = JSON.parse(fs.readFileSync(path.join(SPIKE, "package.json"), "utf8"));
  const installed = JSON.parse(
    fs.readFileSync(path.join(SPIKE, "node_modules", "pyodide", "package.json"), "utf8"),
  );
  const pins = [
    ["package.json devDependencies.pyodide", declared.devDependencies?.pyodide],
    ["node_modules/pyodide", installed.version],
  ];
  for (const [where, version] of pins) {
    if (version !== VERSIONS.pyodide) {
      throw new Error(
        `${where} is ${version}, versions.json says ${VERSIONS.pyodide}: bump both together, then npm ci`,
      );
    }
  }
}

function lockfile() {
  return JSON.parse(
    fs.readFileSync(path.join(SPIKE, "node_modules", "pyodide", "pyodide-lock.json"), "utf8"),
  );
}

// Every package the roots need, transitively, as the lockfile records it.
function closure(lock, roots) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length > 0) {
    const name = todo.pop();
    if (seen.has(name)) continue;
    const pkg = lock.packages[name];
    if (!pkg) throw new Error(`${name} is not in pyodide-lock.json`);
    seen.add(name);
    todo.push(...(pkg.depends ?? []));
  }
  return [...seen].sort();
}

async function fetchVerified(name, pkg, dest) {
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === pkg.sha256) return "cached";
  const res = await fetch(CDN + pkg.file_name);
  if (!res.ok) throw new Error(`GET ${CDN}${pkg.file_name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== pkg.sha256) throw new Error(`sha256 mismatch for ${name} (${pkg.file_name})`);
  fs.writeFileSync(dest, buf);
  return "downloaded";
}

function copySources(srcRoot, dest, manifest) {
  // The browser worker imports the engine and model layers only; ui/ is Qt and data/ is bundled
  // branding. Both are left out so the manifest holds nothing the spike cannot run.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(path.join(REPO, "src"), full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (["__pycache__", "ui", "data"].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".py")) {
        const target = path.join(dest, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        manifest.push(rel);
      }
    }
  };
  walk(path.join(srcRoot, "pdfeditor"));
}

export async function prepare(wheelPath) {
  checkPyodideVersion();
  fs.mkdirSync(PACKAGES, { recursive: true });

  if (wheelPath) {
    const name = path.basename(wheelPath);
    if (!name.startsWith(`pymupdf-${VERSIONS.pymupdf}-`)) {
      throw new Error(`wheel ${name} is not PyMuPDF ${VERSIONS.pymupdf}`);
    }
    const bytes = fs.readFileSync(wheelPath);
    fs.mkdirSync(PACKAGES, { recursive: true });
    fs.copyFileSync(wheelPath, path.join(PACKAGES, name));
    const info = { file: name, bytes: bytes.length, sha256: sha256(bytes) };
    fs.writeFileSync(path.join(DIST, "wheel.json"), JSON.stringify(info, null, 2));
    console.log(`wheel ${name}: ${bytes.length} bytes, sha256 ${info.sha256}`);
  }

  const fixture = path.join(REPO, "tests", "fixtures", "generated", FIXTURE);
  if (!fs.existsSync(fixture)) {
    throw new Error(`${fixture} missing: run scripts/make_fixtures.py first`);
  }
  fs.copyFileSync(fixture, path.join(DIST, "input.pdf"));

  const lock = lockfile();
  const names = closure(lock, VERSIONS.packageRoots);
  fs.copyFileSync(
    path.join(SPIKE, "node_modules", "pyodide", "pyodide-lock.json"),
    path.join(PACKAGES, "pyodide-lock.json"),
  );
  for (const name of names) {
    const pkg = lock.packages[name];
    const how = await fetchVerified(name, pkg, path.join(PACKAGES, pkg.file_name));
    console.log(`package ${name} ${pkg.version} (${how})`);
  }
  fs.writeFileSync(path.join(DIST, "packages.json"), JSON.stringify(names, null, 2));

  const manifest = [];
  copySources(path.join(REPO, "src"), path.join(DIST, "src"), manifest);
  fs.writeFileSync(path.join(DIST, "src-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`staged ${manifest.length} engine/model/core/services sources`);
}

async function run() {
  checkPyodideVersion();
  const wheelInfo = path.join(DIST, "wheel.json");
  if (!fs.existsSync(wheelInfo)) throw new Error("dist/wheel.json missing: run prepare first");
  const wheel = path.join(PACKAGES, JSON.parse(fs.readFileSync(wheelInfo, "utf8")).file);
  fs.mkdirSync(OUT, { recursive: true });

  // A bare "pyodide" would resolve from this folder, which has no node_modules; load the package
  // the spike installed (web/spike/package.json is the only one).
  const { loadPyodide } = await import(
    pathToFileURL(path.join(SPIKE, "node_modules", "pyodide", "pyodide.mjs")).href
  );
  const stdoutLog = [];
  const pyodide = await loadPyodide({
    packageCacheDir: PACKAGES,
    // A package that is not staged must fail, not be fetched from the CDN during the run.
    cdnUrl: "http://127.0.0.1:9/",
    stdout: (line) => stdoutLog.push(line),
    stderr: (line) => stdoutLog.push(line),
  });
  const loadStart = performance.now();
  pyodide.FS.mkdirTree("/repo");
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: REPO }, "/repo");
  pyodide.FS.mkdirTree("/out");
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: OUT }, "/out");

  await pyodide.loadPackage(VERSIONS.packageRoots);
  // Pyodide's Node loader takes a wheel path relative to the working directory: an absolute
  // Windows path is misread and emfs: is not a host path. The wheel keeps its real file name,
  // which Pyodide reads its metadata from.
  const wheelBytes = fs.readFileSync(wheel);
  await pyodide.loadPackage(path.relative(process.cwd(), wheel).split(path.sep).join("/"));
  const loadMs = Math.round(performance.now() - loadStart);

  const started = performance.now();
  const runInfo = JSON.parse(await pyodide.runPythonAsync(PY_RUN));
  const pytestMs = Math.round(performance.now() - started);

  const record = {
    pyodide: pyodide.version,
    pyodideLine: VERSIONS.pyodide,
    wheel: { file: path.basename(wheel), bytes: wheelBytes.length, sha256: sha256(wheelBytes) },
    loadMs,
    pytestMs,
    ...runInfo,
  };
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(OUT, "pyodide-stdout.log"), stdoutLog.join("\n") + "\n");
  console.log(
    `pytest exit ${runInfo.exitCode} in ${pytestMs} ms (Pyodide ${pyodide.version}, ` +
      `PyMuPDF ${runInfo.pymupdf}, MuPDF ${runInfo.mupdf})`,
  );
  if (runInfo.exitCode >= 2) {
    throw new Error(`pytest could not run (exit ${runInfo.exitCode}); see out/pyodide-stdout.log`);
  }
}

// Runs once, inside Pyodide. Returns JSON so the Node side keeps the numbers.
const PY_RUN = `
import json, os, sys, time
sys.dont_write_bytecode = True
sys.path[:0] = ["/repo/web/test/pyodide", "/repo/src"]
os.environ["PYODIDE_SUMMARY"] = "/out/engine-summary.json"
import pymupdf
import pytest

def _mupdf_version():
    try:
        return pymupdf.TOOLS.mupdf_version()
    except Exception as exc:  # the number is for the report; never fail the run on it
        return f"unknown ({exc})"

started = time.time()
code = pytest.main([
    "/repo/tests/engine",
    "-p", "pyodide_conftest",
    "-p", "no:cacheprovider",
    "-o", "addopts=",
    "--rootdir=/repo",
    "--junitxml=/out/engine.xml",
    "-q", "-rfE",
    "-W", "ignore::pytest.PytestConfigWarning",
])
json.dumps({
    "exitCode": int(code),
    "pytestSeconds": round(time.time() - started, 1),
    "pymupdf": str(pymupdf.VersionBind),
    "mupdf": _mupdf_version(),
    "python": sys.version.split()[0],
})
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const wheelIndex = rest.indexOf("--wheel");
  const wheel = wheelIndex >= 0 ? rest[wheelIndex + 1] : undefined;
  try {
    if (cmd === "prepare") await prepare(wheel);
    else if (cmd === "run") await run();
    else {
      console.error("usage: run_engine_tests.mjs prepare [--wheel <file>] | run");
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
