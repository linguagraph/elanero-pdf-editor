// W2.7a: the web test run. Runs the repo's tests under Pyodide in Node, against the web package.
//
//   PYMUPDF_WHEEL=<pymupdf-1.28.2 wasm .whl> WEB_ZIP=<dist/web/pdfeditor-web.zip> \
//     node web/test/pyodide/run_tests.mjs [--stage | --shard k/N]
//
// Three modes, so that several shards can run at once without staging twice:
//   (no argument)  stage, then run every test file as one shard 0/1, writing out/.
//   --stage        check the environment and stage the Pyodide package closure (verified against
//                  pyodide-lock.json sha256) and the PyMuPDF wheel under web/test/pyodide/dist/packages.
//                  The only network use is that staging. Exits 0 when staged.
//   --shard k/N    run shard k of N without staging: the staged files are verified (sha256, no
//                  download) and a missing or different file fails. Writes out-k/.
//
// What a run does, in order:
//   1. Pins: versions.json and the installed Pyodide must agree (the pin is web/spike/versions.json).
//   2. Lists every test_*.py and *_test.py under tests/ (not tests/ui or tests/benchmarks, and not a
//      module marked desktop_only, since an explicit file argument skips pytest's own ignore hook).
//      Sorted by POSIX relative path; shard k takes the files whose index i has i % N == k.
//   3. Starts Pyodide with the repo mounted at /repo (NODEFS) and this shard's output folder at
//      /out. The CDN is pointed at a dead port, so a missing package fails loudly.
//   4. Installs the PyMuPDF wheel and unpacks the web zip into /home/pyodide/pdfeditor. The
//      engine therefore comes from the web package, never from /repo/src (which needs Qt).
//   5. Runs `pytest -m "not desktop_only and not slow and not network"` from /repo/tests on the
//      shard's files, with the pyodide_conftest plugin (host-only stubs for pikepdf and pypdfium2).
//
// Writes pytest.xml, pytest-summary.json, host-checks.json and run.json (with shard, shards and
// files) into the output folder: out/ with no argument, out-k/ with --shard k/N.
// scripts/merge_pyodide_shards.py merges the out-k/ folders into out/ for the checks that follow.
// Exit status: 1 when any test fails or errors (or none is collected), 2 when the harness fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SPIKE,
  VERSIONS,
  checkPyodideVersion,
  closure,
  fetchVerified,
  lockfile,
  pyodideNodeDir,
  sha256,
  verifyStaged,
} from "./packages.mjs";

function requireEnvFile(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  if (!fs.existsSync(value)) throw new Error(`${name}=${value} does not exist`);
  return path.resolve(value);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const DIST = path.join(HERE, "dist");
const PACKAGES = path.join(DIST, "packages");
// The output folder of one shard: out/ for the single-shard run, out-k/ for shard k of N.
const outDirFor = (shard) => path.join(HERE, shard ? `out-${shard.k}` : "out");
// The same roots as the spike. hypothesis and PyYAML are not in them: the modules that import them
// are desktop-only or skip without yaml (tests/unit/test_user_guide.py), so the web run never does.
const PACKAGE_ROOTS = VERSIONS.packageRoots;
const MARK_EXPRESSION = "not desktop_only and not slow and not network";
const WEB_ZIP_IN_PYODIDE = "/home/pyodide/pdfeditor-web.zip";
const WEB_ROOT = "/home/pyodide";
// Directories under tests/ that are never collected by the web run (the plugin skips them too).
const SKIPPED_TEST_DIRS = ["ui", "benchmarks"];

// The Python that runs inside Pyodide. Returns JSON for the Node side to record. `files` are the
// shard's test files, relative to /repo/tests.
const pyRun = (files) => `
import json, os, sys, time, zipfile
sys.dont_write_bytecode = True
zipfile.ZipFile("${WEB_ZIP_IN_PYODIDE}").extractall("${WEB_ROOT}")
sys.path[:0] = ["${WEB_ROOT}", "/repo/web/test/pyodide"]
os.environ["PYODIDE_ENGINE_DIR"] = "${WEB_ROOT}/pdfeditor/engine/"
os.environ["PYODIDE_SUMMARY"] = "/out/pytest-summary.json"
import pymupdf
import pdfeditor
import pytest

# The engine must come from the web package. A desktop copy on the path would pull in Qt.
assert not pdfeditor.__file__.startswith("/repo/"), pdfeditor.__file__
os.chdir("/repo/tests")
started = time.time()
code = pytest.main([
    "-m", "${MARK_EXPRESSION}",
    "-p", "pyodide_conftest",
    "-p", "no:cacheprovider",
    "-o", "addopts=",
    "--rootdir=/repo",
    "--junitxml=/out/pytest.xml",
    "-q", "-rfE",
    "-W", "ignore::pytest.PytestConfigWarning",
    *${JSON.stringify(files)},
])
json.dumps({
    "exitCode": int(code),
    "pytestSeconds": round(time.time() - started, 1),
    "pymupdf": str(pymupdf.VersionBind),
    "pdfeditorFile": pdfeditor.__file__,
    "python": sys.version.split()[0],
})
`;

// `--stage`, `--shard k/N`, or no argument (stage and run one shard 0/1).
export function parseArgs(argv) {
  if (argv.length === 0) return { mode: "all" };
  if (argv.length === 1 && argv[0] === "--stage") return { mode: "stage" };
  if (argv.length === 2 && argv[0] === "--shard") {
    const m = /^(\d+)\/(\d+)$/.exec(argv[1]);
    if (!m) throw new Error(`--shard takes k/N, got ${argv[1]}`);
    const k = Number(m[1]);
    const n = Number(m[2]);
    if (n < 1 || k >= n) throw new Error(`--shard ${argv[1]}: need 0 <= k < N`);
    return { mode: "shard", k, n };
  }
  throw new Error("usage: run_tests.mjs [--stage | --shard k/N]");
}

// True when a module's module-level pytestmark names desktop_only. This is the plugin's rule
// (pyodide_conftest.py _names_desktop_only) applied to the text: the statement runs from
// `pytestmark =` to the next line that starts at column 0.
export function namesDesktopOnly(text) {
  const m = /^pytestmark\s*=/m.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index);
  const end = rest.slice(1).search(/\n\S/);
  const statement = end < 0 ? rest : rest.slice(0, end + 1);
  return /\bdesktop_only\b/.test(statement);
}

// Every test module the web run may collect, as POSIX paths relative to tests/, sorted.
export function listTestFiles(testsRoot) {
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      const rel = path.relative(testsRoot, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        if (!SKIPPED_TEST_DIRS.includes(rel)) walk(full);
        continue;
      }
      const isTest =
        ent.name.endsWith(".py") && (ent.name.startsWith("test_") || ent.name.endsWith("_test.py"));
      if (!isTest) continue;
      if (namesDesktopOnly(fs.readFileSync(full, "utf8"))) continue;
      found.push(rel);
    }
  };
  walk(testsRoot);
  return found.sort();
}

// The files of shard k of n: every n-th file of the sorted list, starting at k.
export function shardFiles(files, k, n) {
  if (n > files.length) {
    throw new Error(`${n} shards for ${files.length} test files: refusing an empty shard`);
  }
  const mine = files.filter((_, i) => i % n === k);
  if (mine.length === 0) throw new Error(`shard ${k}/${n} has no test files`);
  return mine;
}

// The closure goes into PACKAGES, and the wheel next to it, so Pyodide reads its metadata from the
// file name. Only this function downloads; a shard verifies what it left behind.
async function stageAll(lock, wheel, wheelName) {
  fs.mkdirSync(PACKAGES, { recursive: true });
  fs.copyFileSync(
    path.join(pyodideNodeDir(), "pyodide-lock.json"),
    path.join(PACKAGES, "pyodide-lock.json"),
  );
  for (const name of closure(lock, PACKAGE_ROOTS)) {
    const pkg = lock.packages[name];
    const how = await fetchVerified(name, pkg, path.join(PACKAGES, pkg.file_name));
    console.log(`package ${name} ${pkg.version} (${how})`);
  }
  fs.copyFileSync(wheel, path.join(PACKAGES, wheelName));
}

async function runShard(lock, webZip, wheelName, shard, files) {
  const outDir = outDirFor(shard);
  const stagedWheel = path.join(PACKAGES, wheelName);
  const wheelBytes = fs.readFileSync(stagedWheel);
  fs.mkdirSync(outDir, { recursive: true });

  const { loadPyodide } = await import(
    pathToFileURL(path.join(SPIKE, "node_modules", "pyodide", "pyodide.mjs")).href
  );
  const stdoutLog = [];
  const pyodide = await loadPyodide({
    packageCacheDir: PACKAGES,
    cdnUrl: "http://127.0.0.1:9/",
    stdout: (line) => stdoutLog.push(line),
    stderr: (line) => stdoutLog.push(line),
  });
  const loadStart = performance.now();
  pyodide.FS.mkdirTree("/repo");
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: REPO }, "/repo");
  pyodide.FS.mkdirTree("/out");
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: outDir }, "/out");

  await pyodide.loadPackage(PACKAGE_ROOTS);
  // Pyodide's Node loader takes a wheel path relative to the working directory (see
  // run_engine_tests.mjs for why an absolute Windows path does not work).
  await pyodide.loadPackage(path.relative(process.cwd(), stagedWheel).split(path.sep).join("/"));
  pyodide.FS.writeFile(WEB_ZIP_IN_PYODIDE, new Uint8Array(fs.readFileSync(webZip)));
  const loadMs = Math.round(performance.now() - loadStart);

  const started = performance.now();
  const runInfo = JSON.parse(await pyodide.runPythonAsync(pyRun(files)));
  const testMs = Math.round(performance.now() - started);

  const record = {
    shard: shard ? shard.k : 0,
    shards: shard ? shard.n : 1,
    files,
    pyodide: pyodide.version,
    pyodideLine: VERSIONS.pyodide,
    wheel: { file: wheelName, bytes: wheelBytes.length, sha256: sha256(wheelBytes) },
    web: { file: path.basename(webZip), sha256: sha256(fs.readFileSync(webZip)) },
    markerExpression: MARK_EXPRESSION,
    loadMs,
    testMs,
    ...runInfo,
  };
  fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(outDir, "pyodide-stdout.log"), stdoutLog.join("\n") + "\n");
  console.log(
    `pytest exit ${runInfo.exitCode} in ${testMs} ms (Pyodide ${pyodide.version}, ` +
      `PyMuPDF ${runInfo.pymupdf}, engine ${runInfo.pdfeditorFile})`,
  );
  if (runInfo.exitCode !== 0) {
    throw new Error(
      `pytest exit ${runInfo.exitCode}: see ${path.relative(HERE, outDir)}/pyodide-stdout.log ` +
        `and ${path.relative(HERE, outDir)}/pytest.xml`,
    );
  }
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  checkPyodideVersion();
  const wheel = requireEnvFile("PYMUPDF_WHEEL");
  const webZip = requireEnvFile("WEB_ZIP");
  const wheelName = path.basename(wheel);
  if (!wheelName.startsWith(`pymupdf-${VERSIONS.pymupdf}-`)) {
    throw new Error(`PYMUPDF_WHEEL ${wheelName} is not PyMuPDF ${VERSIONS.pymupdf}`);
  }
  const testsRoot = path.join(REPO, "tests");
  if (!fs.existsSync(path.join(testsRoot, "fixtures", "generated", "text_multipage.pdf"))) {
    throw new Error("tests/fixtures/generated is missing: run scripts/make_fixtures.py first");
  }

  const lock = lockfile();
  if (opts.mode === "shard") {
    verifyStaged(PACKAGES, lock, PACKAGE_ROOTS, wheelName);
  } else {
    await stageAll(lock, wheel, wheelName);
  }
  if (opts.mode === "stage") {
    console.log(`staged ${PACKAGE_ROOTS.length} package roots and ${wheelName} in ${PACKAGES}`);
    return;
  }

  const all = listTestFiles(testsRoot);
  const shard = opts.mode === "shard" ? { k: opts.k, n: opts.n } : { k: 0, n: 1 };
  const files = shardFiles(all, shard.k, shard.n);
  console.log(`shard ${shard.k}/${shard.n}: ${files.length} of ${all.length} test files`);
  await runShard(lock, webZip, wheelName, opts.mode === "shard" ? shard : null, files);
}

try {
  await run();
} catch (err) {
  // Harness failures and test failures both end the job. A test failure gets exit 1, a harness
  // failure exit 2, so the log says which one it was.
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = /^pytest exit /.test(message) ? 1 : 2;
}
