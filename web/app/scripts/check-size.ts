// W9.2: fails when a built folder is over the first-load gzip budget (src/deploy/budget.ts).
//
//   node --experimental-strip-types scripts/check-size.ts dist
//
// Every file is gzipped at the highest level, as a compressing server would send it, and the
// per-file sizes are printed largest first, so the wire size of the wheels and Pyodide's wasm is
// visible in the deploy log. Exit code 1 when the total is over the budget.
import { gzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { checkGzipBudget, type SizedFile } from '../src/deploy/budget.ts';

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error('usage: check-size.ts <built folder>');
    return 2;
  }
  const root = resolve(dir);
  const files: SizedFile[] = [];
  for (const absolute of await listFiles(root)) {
    const gzipBytes = gzipSync(await readFile(absolute), { level: 9 }).length;
    files.push({ path: absolute.slice(root.length + 1).replaceAll('\\', '/'), gzipBytes });
  }
  files.sort((a, b) => b.gzipBytes - a.gzipBytes);
  for (const file of files.slice(0, 15)) {
    console.log(`${(file.gzipBytes / 1e6).toFixed(2).padStart(8)} MB  ${file.path}`);
  }
  const result = checkGzipBudget(files);
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
  console.log(`gzip total ${mb(result.totalBytes)} of a ${mb(result.budgetBytes)} budget`);
  if (!result.withinBudget) {
    console.error('::error::the built app is over the first-load gzip budget');
    return 1;
  }
  return 0;
}

process.exitCode = await main();
