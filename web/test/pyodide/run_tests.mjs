// W2.7a: the web test run. Runs the repo's tests under Pyodide in Node, against the web package.
//
//   PYMUPDF_WHEEL=<pymupdf-1.28.2 wasm .whl> WEB_ZIP=<dist/web/pdfeditor-web.zip> \
//     node web/test/pyodide/run_tests.mjs
//
// What it does, in order:
//   1. Pins: versions.json and the installed Pyodide must agree (the pin is web/spike/versions.json).
//   2. Stages the Pyodide package closure (verified against pyodide-lock.json sha256) and the
//      PyMuPDF wheel under web/test/pyodide/dist/packages. The only network use is that staging.
//   3. Starts Pyodide with the repo mounted at /repo (NODEFS) and an output folder at /out.
//      The CDN is pointed at a dead port, so a missing package fails loudly.
//   4. Installs the PyMuPDF wheel and unpacks the web zip into /home/pyodide/pdfeditor. The
//      engine therefore comes from the web package, never from /repo/src (which needs Qt).
//   5. Runs `pytest -m "not desktop_only and not slow and not network"` from /repo/tests, with
//      the pyodide_conftest plugin (host-only stubs for pikepdf and pypdfium2).
//
// Writes out/pytest.xml, out/pytest-summary.json and out/run.json under web/test/pyodide/out.
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
  sha256,
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
const OUT = path.join(HERE, "out");
// The same roots as the spike. hypothesis and PyYAML are not in them: the modules that import them
// are desktop-only or skip without yaml (tests/unit/test_user_guide.py), so the web run never does.
const PACKAGE_ROOTS = VERSIONS.packageRoots;
const MARK_EXPRESSION = "not desktop_only and not slow and not network";
const WEB_ZIP_IN_PYODIDE = "/home/pyodide/pdfeditor-web.zip";
const WEB_ROOT = "/home/pyodide";

// The Python that runs inside Pyodide. Returns JSON for the Node side to record.
const PY_RUN = `
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
    ".",
])
json.dumps({
    "exitCode": int(code),
    "pytestSeconds": round(time.time() - started, 1),
    "pymupdf": str(pymupdf.VersionBind),
    "pdfeditorFile": pdfeditor.__file__,
    "python": sys.version.split()[0],
})
`;

async function run() {
  checkPyodideVersion();
  const wheel = requireEnvFile("PYMUPDF_WHEEL");
  const webZip = requireEnvFile("WEB_ZIP");
  const wheelName = path.basename(wheel);
  if (!wheelName.startsWith(`pymupdf-${VERSIONS.pymupdf}-`)) {
    throw new Error(`PYMUPDF_WHEEL ${wheelName} is not PyMuPDF ${VERSIONS.pymupdf}`);
  }
  if (!fs.existsSync(path.join(REPO, "tests", "fixtures", "generated", "text_multipage.pdf"))) {
    throw new Error("tests/fixtures/generated is missing: run scripts/make_fixtures.py first");
  }

  // Stage the closure. The wheel goes next to it, so Pyodide reads its metadata from the file name.
  fs.mkdirSync(PACKAGES, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const lock = lockfile();
  fs.copyFileSync(
    path.join(SPIKE, "node_modules", "pyodide", "pyodide-lock.json"),
    path.join(PACKAGES, "pyodide-lock.json"),
  );
  for (const name of closure(lock, PACKAGE_ROOTS)) {
    const pkg = lock.packages[name];
    const how = await fetchVerified(name, pkg, path.join(PACKAGES, pkg.file_name));
    console.log(`package ${name} ${pkg.version} (${how})`);
  }
  const stagedWheel = path.join(PACKAGES, wheelName);
  fs.copyFileSync(wheel, stagedWheel);
  const wheelBytes = fs.readFileSync(stagedWheel);

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
  pyodide.FS.mount(pyodide.FS.filesystems.NODEFS, { root: OUT }, "/out");

  await pyodide.loadPackage(PACKAGE_ROOTS);
  // Pyodide's Node loader takes a wheel path relative to the working directory (see
  // run_engine_tests.mjs for why an absolute Windows path does not work).
  await pyodide.loadPackage(path.relative(process.cwd(), stagedWheel).split(path.sep).join("/"));
  pyodide.FS.writeFile(WEB_ZIP_IN_PYODIDE, new Uint8Array(fs.readFileSync(webZip)));
  const loadMs = Math.round(performance.now() - loadStart);

  const started = performance.now();
  const runInfo = JSON.parse(await pyodide.runPythonAsync(PY_RUN));
  const testMs = Math.round(performance.now() - started);

  const record = {
    pyodide: pyodide.version,
    pyodideLine: VERSIONS.pyodide,
    wheel: { file: wheelName, bytes: wheelBytes.length, sha256: sha256(wheelBytes) },
    web: { file: path.basename(webZip), sha256: sha256(fs.readFileSync(webZip)) },
    markerExpression: MARK_EXPRESSION,
    loadMs,
    testMs,
    ...runInfo,
  };
  fs.writeFileSync(path.join(OUT, "run.json"), JSON.stringify(record, null, 2));
  fs.writeFileSync(path.join(OUT, "pyodide-stdout.log"), stdoutLog.join("\n") + "\n");
  console.log(
    `pytest exit ${runInfo.exitCode} in ${testMs} ms (Pyodide ${pyodide.version}, ` +
      `PyMuPDF ${runInfo.pymupdf}, engine ${runInfo.pdfeditorFile})`,
  );
  if (runInfo.exitCode !== 0) {
    throw new Error(
      `pytest exit ${runInfo.exitCode}: see out/pyodide-stdout.log and out/pytest.xml`,
    );
  }
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
