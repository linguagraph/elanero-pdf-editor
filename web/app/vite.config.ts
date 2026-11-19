import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { baseFor } from './src/deploy/base.ts';
import { CSP_POLICY } from './src/csp.ts';
import {
  appCacheName,
  buildIdSource,
  buildManifest,
  renderServiceWorker,
  type PrecacheFile,
} from './src/pwa/build.ts';
import { APP_VERSION } from './src/version.ts';

// The source link in the About page points at the exact build. If git is missing (for
// example in a source-only archive) the link still renders, pointing at "unknown".
function gitCommit(): string {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: new URL('.', import.meta.url),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

// The React refresh preamble is an inline script, which the strict CSP blocks. In `vite`
// (dev server) only, the page gets a policy that allows inline scripts. The transform runs
// only when there is a dev server, so `vite build` output keeps the strict policy.
const DEV_SCRIPT_SRC = "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'";
// Vite's dev server injects CSS through <style> elements, which style-src 'self' blocks, so the
// dev policy also allows inline styles. The build's CSS is a stylesheet file and needs neither.
const DEV_STYLE_SRC = "style-src 'self' 'unsafe-inline'";
function devRelaxedCsp(): Plugin {
  return {
    name: 'elanero-dev-relaxed-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      const strictScriptSrc = "script-src 'self' 'wasm-unsafe-eval'";
      if (!html.includes(CSP_POLICY)) {
        throw new Error('index.html CSP meta does not match CSP_POLICY');
      }
      const relaxed = CSP_POLICY.replace(strictScriptSrc, DEV_SCRIPT_SRC).replace(
        "style-src 'self'",
        DEV_STYLE_SRC,
      );
      return html.replace(CSP_POLICY, relaxed);
    },
  };
}

// The PWA build step (W4.6). The manifest is generated from the design tokens. After Vite has
// written the output, every file in it is hashed, the build id is derived from those hashes, and
// dist/sw.js is filled in with the cache name and the file list. The worker then refuses any file
// whose SHA-256 differs, so its cache holds exactly what this build produced.
const SW_FILE = 'sw.js';

function serviceWorkerBuild(commit: string): Plugin {
  let outDir = '';
  return {
    name: 'elanero-pwa',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: `${JSON.stringify(buildManifest(), null, 2)}\n`,
      });
    },
    async closeBundle() {
      const relatives = (await readdir(outDir, { recursive: true })).map((path) =>
        path.split(/[\\/]/).join('/'),
      );
      const files: PrecacheFile[] = [];
      for (const relative of relatives) {
        if (relative === SW_FILE) continue;
        const absolute = join(outDir, relative);
        if (!(await stat(absolute)).isFile()) continue;
        const digest = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
        files.push({ path: relative, sha256: digest });
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const buildId = createHash('sha256').update(buildIdSource(files)).digest('hex').slice(0, 12);
      const cacheName = appCacheName(APP_VERSION, buildId);
      const swPath = join(outDir, SW_FILE);
      const source = await readFile(swPath, 'utf8');
      await writeFile(swPath, renderServiceWorker(source, { cacheName, commit, files }));
    },
  };
}

// A function of the command, so the production base (W9.2) applies to `vite build` only.
export default defineConfig(({ command }) => ({
  base: baseFor(command),
  plugins: [react(), devRelaxedCsp(), serviceWorkerBuild(gitCommit())],
  define: {
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  // The engine worker is an ES module: the page starts it by importing its URL from a blob: worker
  // (engine/start.ts), and an IIFE bundle would not run that way under the page CSP.
  worker: { format: 'es' },
}));
