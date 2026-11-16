// W0.2 staging (spike-only, never imported by the app). Run once before the perf harness:
//
//   node perf/stage.mjs --wheel <pymupdf-wasm.whl> [--python <host python>]
//
// Stages, under web/spike/dist/ (git-ignored):
//   packages/            the PyMuPDF wheel, the Pyodide lock, and the package closure of fonttools
//                        and pillow (the only network use; each file is checked against the sha256
//                        in pyodide-lock.json)
//   perf/wheel.json      the wheel's name, size and sha256
//   perf/packages.json   the package names of the "full set" (fonttools, pillow and their deps)
//   perf/pdfeditor-web.zip   the trimmed pdfeditor package (web/spike/web_package.py, M1)
//   perf/fixtures/       perf_mixed_{10,200,1000}.pdf from tests/fixtures/generated, and the local
//                        scanned sample as scanned_dryer.pdf when it exists (it is git-ignored)
//
// Nothing here runs in the browser. The browser harness reads only what this step staged.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // web/spike/perf
const SPIKE = path.resolve(HERE, "..");
const REPO = path.resolve(SPIKE, "..", "..");
const DIST = path.join(SPIKE, "dist");
const PACKAGES = path.join(DIST, "packages");
const PERF = path.join(DIST, "perf");
const VERSIONS = JSON.parse(fs.readFileSync(path.join(SPIKE, "versions.json"), "utf8"));
const CDN = `https://cdn.jsdelivr.net/pyodide/v${VERSIONS.pyodide}/full/`;

// The W0.2 "full set": what the harness loads at first start. The lock file gives the closure.
export const FULL_SET_ROOTS = ["fonttools", "pillow"];
export const FIXTURES = ["perf_mixed_10.pdf", "perf_mixed_200.pdf", "perf_mixed_1000.pdf"];
export const LOCAL_SCAN = "scanned_dryer_manual.pdf"; // git-ignored, third-party, local only

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function lockfile() {
  return JSON.parse(
    fs.readFileSync(path.join(SPIKE, "node_modules", "pyodide", "pyodide-lock.json"), "utf8"),
  );
}

// Every package the roots need, transitively, as the lockfile records it.
export function closure(lock, roots) {
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

function parseArgs(argv) {
  const out = { wheel: null, python: process.env.PYTHON || "python" };
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === "--wheel") out.wheel = argv[i + 1];
    else if (argv[i] === "--python") out.python = argv[i + 1];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

async function stage({ wheel, python }) {
  const declared = JSON.parse(fs.readFileSync(path.join(SPIKE, "package.json"), "utf8"));
  if (declared.devDependencies?.pyodide !== VERSIONS.pyodide) {
    throw new Error("package.json and versions.json disagree on the Pyodide version");
  }
  fs.mkdirSync(PACKAGES, { recursive: true });
  fs.mkdirSync(PERF, { recursive: true });
  fs.mkdirSync(path.join(PERF, "fixtures"), { recursive: true });

  if (!wheel) throw new Error("--wheel <file> is required (the W0.1 wheel)");
  const name = path.basename(wheel);
  if (!name.startsWith(`pymupdf-${VERSIONS.pymupdf}-`)) {
    throw new Error(`wheel ${name} is not PyMuPDF ${VERSIONS.pymupdf}`);
  }
  const wheelBytes = fs.readFileSync(wheel);
  fs.copyFileSync(wheel, path.join(PACKAGES, name));
  const wheelInfo = { file: name, bytes: wheelBytes.length, sha256: sha256(wheelBytes) };
  fs.writeFileSync(path.join(PERF, "wheel.json"), JSON.stringify(wheelInfo, null, 2));
  console.log(`wheel ${name}: ${wheelBytes.length} bytes`);

  const lock = lockfile();
  fs.copyFileSync(
    path.join(SPIKE, "node_modules", "pyodide", "pyodide-lock.json"),
    path.join(PACKAGES, "pyodide-lock.json"),
  );
  const names = closure(lock, FULL_SET_ROOTS);
  for (const pkgName of names) {
    const pkg = lock.packages[pkgName];
    const how = await fetchVerified(pkgName, pkg, path.join(PACKAGES, pkg.file_name));
    console.log(`package ${pkgName} ${pkg.version} (${how})`);
  }
  fs.writeFileSync(path.join(PERF, "packages.json"), JSON.stringify(names, null, 2));

  const zip = path.join(PERF, "pdfeditor-web.zip");
  execFileSync(python, [path.join(SPIKE, "web_package.py"), zip], { stdio: "inherit" });
  // The web set leaves out engine/mupdf/ocr_worker.py, which engine/mupdf/ocr.py imports at module
  // level: a shim (perf/shims/ocr_worker.py) keeps the engine importable. See the W0.2 report.
  execFileSync(python, [path.join(HERE, "shim_zip.py"), zip], { stdio: "inherit" });

  for (const file of FIXTURES) {
    const src = path.join(REPO, "tests", "fixtures", "generated", file);
    if (!fs.existsSync(src)) throw new Error(`${src} missing: run scripts/make_fixtures.py first`);
    fs.copyFileSync(src, path.join(PERF, "fixtures", file));
  }
  const scan = path.join(REPO, "tests", "fixtures", "real", LOCAL_SCAN);
  if (fs.existsSync(scan)) {
    fs.copyFileSync(scan, path.join(PERF, "fixtures", "scanned_dryer.pdf"));
    console.log("staged the local scanned sample");
  } else {
    console.log("no local scanned sample: the scanned case is skipped");
  }
}

async function main() {
  try {
    await stage(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
