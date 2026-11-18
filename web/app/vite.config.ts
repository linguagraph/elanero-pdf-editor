import { execSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CSP_POLICY } from './src/csp.ts';

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
function devRelaxedCsp(): Plugin {
  return {
    name: 'elanero-dev-relaxed-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      const strictScriptSrc = "script-src 'self' 'wasm-unsafe-eval'";
      if (!html.includes(CSP_POLICY)) {
        throw new Error('index.html CSP meta does not match CSP_POLICY');
      }
      return html.replace(CSP_POLICY, CSP_POLICY.replace(strictScriptSrc, DEV_SCRIPT_SRC));
    },
  };
}

export default defineConfig({
  plugins: [react(), devRelaxedCsp()],
  define: {
    __APP_COMMIT__: JSON.stringify(gitCommit()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
