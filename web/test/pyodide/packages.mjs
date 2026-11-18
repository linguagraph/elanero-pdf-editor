// Shared staging helpers for the Pyodide runs (W2.7a and W3.1): the pinned Pyodide version, the
// package closure from pyodide-lock.json, and the sha256-checked download from the Pyodide CDN.
// The pins come from web/spike/versions.json and the installed npm package; nothing is copied here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// web/spike holds the one versions.json and the one package.json (with node_modules).
export const SPIKE = path.resolve(HERE, "..", "..", "spike");
export const VERSIONS = JSON.parse(fs.readFileSync(path.join(SPIKE, "versions.json"), "utf8"));
export const CDN = `https://cdn.jsdelivr.net/pyodide/v${VERSIONS.pyodide}/full/`;

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function checkPyodideVersion() {
  const declared = JSON.parse(fs.readFileSync(path.join(SPIKE, "package.json"), "utf8"));
  const installed = JSON.parse(
    fs.readFileSync(path.join(SPIKE, "node_modules", "pyodide", "package.json"), "utf8"),
  );
  const pins = [
    ["web/spike/package.json devDependencies.pyodide", declared.devDependencies?.pyodide],
    ["web/spike/node_modules/pyodide", installed.version],
  ];
  for (const [where, version] of pins) {
    if (version !== VERSIONS.pyodide) {
      throw new Error(
        `${where} is ${version}, versions.json says ${VERSIONS.pyodide}: bump both together, then npm ci`,
      );
    }
  }
}

export function pyodideNodeDir() {
  return path.join(SPIKE, "node_modules", "pyodide");
}

export function lockfile() {
  return JSON.parse(fs.readFileSync(path.join(pyodideNodeDir(), "pyodide-lock.json"), "utf8"));
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

// Downloads one package file unless a copy with the lockfile's sha256 is already in dest.
export async function fetchVerified(name, pkg, dest) {
  if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) === pkg.sha256) return "cached";
  const res = await fetch(CDN + pkg.file_name);
  if (!res.ok) throw new Error(`GET ${CDN}${pkg.file_name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== pkg.sha256) throw new Error(`sha256 mismatch for ${name} (${pkg.file_name})`);
  fs.writeFileSync(dest, buf);
  return "downloaded";
}
