import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CSP_POLICY, REFERRER_POLICY } from './csp';

const indexHtml = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'),
  'utf8',
);

function metaContents(pattern: RegExp): string[] {
  return [...indexHtml.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('index.html security meta tags', () => {
  it('has exactly one CSP meta tag, equal to CSP_POLICY', () => {
    const csp = metaContents(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi,
    );
    expect(csp).toEqual([CSP_POLICY]);
  });

  it('has exactly one referrer meta tag, equal to REFERRER_POLICY', () => {
    const referrer = metaContents(/<meta\s+name="referrer"\s+content="([^"]*)"\s*\/?>/gi);
    expect(referrer).toEqual([REFERRER_POLICY]);
  });

  it('has no inline script and no inline event handler', () => {
    expect(indexHtml).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/i);
    expect(indexHtml).not.toMatch(/\son[a-z]+\s*=/i);
  });
});
