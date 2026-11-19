import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { PRODUCTION_BASE } from './deploy/base';
import { CSP_POLICY } from './csp';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('production build', () => {
  it('ships only the strict CSP, with no inline script', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'elanero-build-'));
    try {
      await build({ root: appRoot, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
      const html = await readFile(join(outDir, 'index.html'), 'utf8');

      const csp = [
        ...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/gi),
      ].map((match) => match[1] ?? '');
      expect(csp).toEqual([CSP_POLICY]);
      // The dev server's relaxed policy must never reach the build output.
      expect(csp[0]).not.toContain("'unsafe-inline'");
      expect(csp[0]).not.toContain("'unsafe-eval'");

      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
      expect(html).toMatch(/<script type="module"[^>]*\ssrc="[^"]+"/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('resolves every page and manifest URL under the production base path (W9.2)', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'elanero-base-'));
    try {
      await build({ root: appRoot, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
      const html = await readFile(join(outDir, 'index.html'), 'utf8');
      // The origin is only a stand-in for resolving the URLs the way a browser would.
      const origin = 'https://example.invalid';
      const page = new URL(`${PRODUCTION_BASE}index.html`, origin);

      expect(html).toContain(`src="${PRODUCTION_BASE}assets/`);
      const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(new URL(ref, page).pathname.startsWith(PRODUCTION_BASE), ref).toBe(true);
      }

      // The manifest uses relative URLs: start_url and scope resolve against the manifest's own
      // address, which sits in the base folder.
      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.webmanifest'), 'utf8')) as {
        start_url: string;
        scope: string;
        icons: { src: string }[];
      };
      const manifestUrl = new URL(`${PRODUCTION_BASE}manifest.webmanifest`, origin);
      for (const ref of [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) {
        expect(new URL(ref, manifestUrl).pathname.startsWith(PRODUCTION_BASE), ref).toBe(true);
      }
      expect(new URL(manifest.scope, manifestUrl).pathname).toBe(PRODUCTION_BASE);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 180_000);
});
