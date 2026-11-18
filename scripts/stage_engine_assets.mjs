// W3.1: stages the browser engine's same-origin assets into web/app/public/engine-assets/.
//
//   PYMUPDF_WHEEL=<pymupdf wasm .whl> WEB_ZIP=<dist/web/pdfeditor-web.zip> \
//     node scripts/stage_engine_assets.mjs
//   (or: node scripts/stage_engine_assets.mjs --wheel <whl> --zip <zip>)
//
// It copies the pinned Pyodide core (from the web/spike npm package, the one versions.json pins),
// the Pyodide package closure the browser needs (Pillow; each file checked against
// pyodide-lock.json's sha256), the PyMuPDF wheel and the web zip. The output folder is git-ignored
// and is the only place the loader reads from (web/app/src/engine/loader.ts, baseUrl). The only
// network use is the closure download from the Pyodide CDN, which is the same one the Pyodide
// test run uses.
//
// The package closure here is smaller than the test run's (no pytest, numpy): the app ships only
// what the engine imports (scripts/build_web_wheel.py, EXPECTED_RUNTIME).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSIONS,
  checkPyodideVersion,
  closure,
  fetchVerified,
  lockfile,
  pyodideNodeDir,
  sha256,
} from "../web/test/pyodide/packages.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(REPO, "web", "app", "public", "engine-assets");
// The app's own runtime needs: Pillow (imported at module level by the engine). See
// scripts/build_web_wheel.py EXPECTED_RUNTIME.
const APP_PACKAGE_ROOTS = ["pillow"];
// The Pyodide files loadPyodide reads from its indexURL (the npm package's own copies).
const CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
  "pyodide-lock.json",
];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredFile(label, value) {
  if (!value) throw new Error(`${label} is not set (env or --${label.toLowerCase()} argument)`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label}=${resolved} does not exist`);
  return resolved;
}

async function run() {
  checkPyodideVersion();
  const wheel = requiredFile("PYMUPDF_WHEEL", argValue("--wheel") ?? process.env.PYMUPDF_WHEEL);
  const zip = requiredFile("WEB_ZIP", argValue("--zip") ?? process.env.WEB_ZIP);
  const wheelName = path.basename(wheel);
  if (!wheelName.startsWith(`pymupdf-${VERSIONS.pymupdf}-`)) {
    throw new Error(`the wheel ${wheelName} is not PyMuPDF ${VERSIONS.pymupdf}`);
  }
  const wheelBytes = fs.readFileSync(wheel);
  // The PyPI copy is checked against the sha256 recorded in versions.json. Other wheels (a
  // self-built one) are recorded in the manifest and checked by whoever built them.
  if (VERSIONS.pypiWheel?.file === wheelName && sha256(wheelBytes) !== VERSIONS.pypiWheel.sha256) {
    throw new Error(`${wheelName} does not match the sha256 in versions.json`);
  }

  // Start clean, so a removed package does not linger in the served folder.
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.mkdirSync(TARGET, { recursive: true });

  const core = pyodideNodeDir();
  for (const name of CORE_FILES) {
    fs.copyFileSync(path.join(core, name), path.join(TARGET, name));
  }

  const lock = lockfile();
  const packages = [];
  for (const name of closure(lock, APP_PACKAGE_ROOTS)) {
    const pkg = lock.packages[name];
    const how = await fetchVerified(name, pkg, path.join(TARGET, pkg.file_name));
    console.log(`package ${name} ${pkg.version} (${how})`);
    packages.push({ name, version: pkg.version, file: pkg.file_name, sha256: pkg.sha256 });
  }

  fs.copyFileSync(wheel, path.join(TARGET, wheelName));
  fs.copyFileSync(zip, path.join(TARGET, path.basename(zip)));
  // The loader names the zip pdfeditor-web.zip (WEB_ZIP_FILE in pins.ts): keep that name.
  if (path.basename(zip) !== "pdfeditor-web.zip") {
    fs.copyFileSync(zip, path.join(TARGET, "pdfeditor-web.zip"));
    fs.rmSync(path.join(TARGET, path.basename(zip)));
  }

  const manifest = {
    pyodide: VERSIONS.pyodide,
    core: CORE_FILES,
    packages,
    wheel: { file: wheelName, bytes: wheelBytes.length, sha256: sha256(wheelBytes) },
    web: { file: "pdfeditor-web.zip", sha256: sha256(fs.readFileSync(zip)) },
  };
  fs.writeFileSync(path.join(TARGET, "stage-manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`staged ${TARGET}`);
  console.log(`  wheel ${wheelName} sha256 ${manifest.wheel.sha256}`);
  console.log(`  web zip sha256 ${manifest.web.sha256}`);
}

try {
  await run();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
