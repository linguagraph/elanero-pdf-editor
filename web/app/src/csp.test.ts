import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRANSLATION_ORIGINS } from './engine/translationNet';
import { CSP_POLICY, REFERRER_POLICY } from './csp';

// F7 (trusted-types) is deferred, not shipped: the design (W8.6 S2b, owner question 2) adds
// `trusted-types elanero-worker-url elanero-sw-url` only after the engine-load and security specs
// pass on Chromium, Firefox and WebKit. Those specs were not run for this change, so the policy
// keeps only `require-trusted-types-for 'script'` and no `trusted-types` allow-list.

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

// Parses the serialized policy into `name -> source list`, failing on a duplicate name (a browser
// keeps only the first copy, so a duplicate would silently hide a looser one).
function parseDirectives(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const raw of policy.split(';')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0] ?? '';
    if (directives.has(name)) throw new Error(`duplicate CSP directive: ${name}`);
    directives.set(name, parts.slice(1));
  }
  return directives;
}

const directives = parseDirectives(CSP_POLICY);

describe('CSP_POLICY directives', () => {
  it.each([
    'default-src',
    'script-src',
    'style-src',
    'connect-src',
    'img-src',
    'worker-src',
    'font-src',
    'object-src',
    'base-uri',
    'require-trusted-types-for',
  ])('has the %s directive', (name) => {
    expect(directives.has(name)).toBe(true);
  });

  it("restricts the default to 'self'", () => {
    expect(directives.get('default-src')).toEqual(["'self'"]);
  });

  it("denies plugins with object-src 'none'", () => {
    expect(directives.get('object-src')).toEqual(["'none'"]);
  });

  it("denies <base> rewriting with base-uri 'none'", () => {
    expect(directives.get('base-uri')).toEqual(["'none'"]);
  });

  it("requires Trusted Types for script with require-trusted-types-for 'script'", () => {
    expect(directives.get('require-trusted-types-for')).toEqual(["'script'"]);
  });

  it("allows scripts from 'self' and WebAssembly compilation only", () => {
    expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it('allows workers from self and blob: only', () => {
    expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
  });

  it("allows styles from 'self' only", () => {
    expect(directives.get('style-src')).toEqual(["'self'"]);
  });

  it("allows fonts from 'self' only", () => {
    expect(directives.get('font-src')).toEqual(["'self'"]);
  });

  it("allows images from 'self', blob: and data: only", () => {
    expect(directives.get('img-src')).toEqual(["'self'", 'blob:', 'data:']);
  });

  // Adding an origin here needs a worker gate (TRANSLATION_ORIGINS) and a spec, per the W1.1 rule.
  it("connects to 'self' and the translation origin only", () => {
    const connect = directives.get('connect-src') ?? [];
    expect(new Set(connect)).toEqual(new Set(["'self'", 'https://api.mymemory.translated.net']));
    expect(connect).toHaveLength(2);
  });

  it('keeps connect-src in step with the engine translation origins', () => {
    const connect = (directives.get('connect-src') ?? []).filter((source) => source !== "'self'");
    expect(connect).toEqual([...TRANSLATION_ORIGINS]);
  });

  it("never uses 'unsafe-inline' or 'unsafe-eval' in any directive", () => {
    for (const [name, sources] of directives) {
      for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'"]) {
        expect(sources, `${name} must not allow ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("never uses a wildcard source '*'", () => {
    for (const [name, sources] of directives) {
      expect(sources, `${name} must not allow '*'`).not.toContain('*');
    }
  });
});
