// Test-only dev server for the engine harness (W3.1). It serves web/app/src, so the workers are
// the real modules, under the production CSP (src/csp.ts). Nothing here is used by `vite build`.
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { CSP_POLICY } from '../../src/csp.ts';

const APP_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// The harness page carries the production policy verbatim. The app's dev config relaxes
// script-src for React's preamble; this config does not, so the harness runs under the policy
// that ships.
function productionCsp(): Plugin {
  return {
    name: 'elanero-harness-csp',
    transformIndexHtml(html) {
      return html.replace('__CSP_POLICY__', CSP_POLICY);
    },
  };
}

export default defineConfig({
  root: APP_ROOT,
  plugins: [productionCsp()],
  server: { hmr: false, fs: { allow: [APP_ROOT] } },
});
