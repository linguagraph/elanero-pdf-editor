import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
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
});
