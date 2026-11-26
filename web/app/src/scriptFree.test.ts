import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// F9 (browser half): the app never embeds a PDF script engine or a plugin element, so a PDF's
// JavaScript has no page to run in. These tests pin that by its two visible traces, both of which
// are current behaviour: no PDF.js-style dependency in package.json, and no source file that makes
// an <embed> or <object> element. They are a tripwire, not a proof; the security spec checks the
// observable rule in the browser.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(APP, 'src');

// Source files that count: every .ts, .tsx, .js, .jsx or .mjs under src, except the test files.
// The scan looks at literal strings only, so ObjectCache and similar names do not match.
const SOURCE = /\.(ts|tsx|js|jsx|mjs)$/;
const TEST = /\.test\.(ts|tsx|js|jsx|mjs)$/;

const BANNED = [
  '<embed',
  '<object',
  "createElement('object')",
  'createElement("object")',
  "createElement('embed')",
  'createElement("embed")',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(full);
  }
  return out;
}

describe('no PDF script engine in the app', () => {
  it('package.json has no PDF.js-style dependency', () => {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.filter((name) => /pdf(js|\.js|-dist)|pdfjs/i.test(name))).toEqual([]);
  });

  it('no non-test source file makes an <embed> or <object> element', () => {
    const files = sourceFiles(SRC);
    // Guard against an empty scan that would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    const hits = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return BANNED.filter((literal) => text.includes(literal)).map(
        (literal) => `${file}: ${literal}`,
      );
    });
    expect(hits).toEqual([]);
  });
});
