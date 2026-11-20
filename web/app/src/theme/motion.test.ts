import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reduced motion at the source (W8.5 S2). Every stylesheet that starts a transition, an
// animation or a smooth scroll must turn it off under prefers-reduced-motion, rule by rule:
// each selector that animates has its own override in the same file. A failure names the file
// and the selector with no override.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');

const REDUCE_OPEN = '@media (prefers-reduced-motion: reduce) {';

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

// Removes comments so their text never reads as a declaration.
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Splits a stylesheet into its reduced-motion bodies and the rest. The blocks here hold plain
// rules (no nesting), so brace counting from the opening line is enough.
function splitReduceBlocks(css: string): { reduce: string; rest: string } {
  let rest = '';
  let reduce = '';
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(REDUCE_OPEN, cursor);
    if (start === -1) break;
    rest += css.slice(cursor, start);
    let depth = 0;
    let end = start + REDUCE_OPEN.length - 1;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    reduce += css.slice(start + REDUCE_OPEN.length, end) + '\n';
    cursor = end + 1;
  }
  rest += css.slice(cursor);
  return { reduce, rest };
}

interface Rule {
  selector: string;
  decls: Map<string, string>;
}

function parseRules(text: string): Rule[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim().replace(/\s+/g, ' '),
    decls: new Map(
      (m[2] ?? '')
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const colon = d.indexOf(':');
          return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()] as const;
        }),
    ),
  }));
}

// The property families that move things, and the value that turns each one off.
const MOTION: Array<{ prop: RegExp; off: RegExp; name: string }> = [
  {
    prop: /^(transition|transition-duration)$/,
    off: /^(none|0s?|0ms)(\s|!|$)/,
    name: 'transition',
  },
  {
    prop: /^(animation|animation-duration)$/,
    off: /^(none|0s?|0ms)(\s|!|$)/,
    name: 'animation',
  },
  { prop: /^scroll-behavior$/, off: /^auto(\s|!|$)/, name: 'scroll-behavior' },
];

function motionDecls(rule: Rule): Array<{ name: string; prop: string; off: RegExp }> {
  const found: Array<{ name: string; prop: string; off: RegExp }> = [];
  for (const [prop] of rule.decls) {
    for (const family of MOTION) {
      if (family.prop.test(prop)) found.push({ name: family.name, prop, off: family.off });
    }
  }
  return found;
}

function overridesFor(reduceRules: Rule[], selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of reduceRules) {
    if (
      !rule.selector
        .split(',')
        .map((s) => s.trim())
        .includes(selector)
    )
      continue;
    for (const [prop, value] of rule.decls) merged.set(prop, value);
  }
  return merged;
}

const files = cssFiles(srcRoot).map((path) => ({
  name: relative(srcRoot, path).replaceAll(String.fromCharCode(92), '/'),
  css: stripComments(readFileSync(path, 'utf8')),
}));

describe('reduced motion in the stylesheets', () => {
  it('finds the stylesheets (guards against an empty scan)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('keeps the reduced-motion rules in layout, feedback and the canvas pill', () => {
    for (const name of ['layout/layout.css', 'feedback/feedback.css', 'view/canvasPill.css']) {
      const file = files.find((f) => f.name === name);
      expect(file, name).toBeDefined();
      expect(splitReduceBlocks(file?.css ?? '').reduce.trim(), name).not.toBe('');
    }
  });

  for (const file of files) {
    it(`${file.name}: every moving rule has a reduced-motion override`, () => {
      const { reduce, rest } = splitReduceBlocks(file.css);
      const reduceRules = parseRules(reduce);
      const problems: string[] = [];

      for (const rule of parseRules(rest)) {
        for (const { name, prop, off } of motionDecls(rule)) {
          const value = rule.decls.get(prop) ?? '';
          // A value already off (for example `animation: none`) needs no override.
          if (off.test(value)) continue;
          // Each selector in a comma list is checked on its own.
          for (const selector of rule.selector.split(',').map((s) => s.trim())) {
            const override = overridesFor(reduceRules, selector);
            const offValue = [...override].find(([p]) => p === prop)?.[1];
            if (offValue === undefined || !off.test(offValue)) {
              problems.push(
                `${file.name}: ${selector} sets ${prop}: ${value} with no ${name} override under prefers-reduced-motion`,
              );
            }
          }
        }
      }

      expect(problems).toEqual([]);
    });
  }
});
