import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Reduced motion at the source (W8.5 S2). Every stylesheet that starts a transition, an
// animation or a smooth scroll must turn it off under prefers-reduced-motion. A moving rule is
// covered when a reduced-motion rule for the same selector, or for a broader selector that
// contains it (such as `.app-frame *` for `.app-frame .toast`), sets the property off, either
// directly or through the shorthand that resets it. A failure names the file and the selector.

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

// Index of the brace that closes the one at `open`. The stylesheets here hold no string literals
// with braces, so counting is enough.
function closingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

// Splits a stylesheet into its reduced-motion bodies and the rest.
function splitReduceBlocks(css: string): { reduce: string; rest: string } {
  let rest = '';
  let reduce = '';
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(REDUCE_OPEN, cursor);
    if (start === -1) break;
    rest += css.slice(cursor, start);
    const end = closingBrace(css, start + REDUCE_OPEN.length - 1);
    reduce += css.slice(start + REDUCE_OPEN.length, end) + '\n';
    cursor = end + 1;
  }
  rest += css.slice(cursor);
  return { reduce, rest };
}

// Removes @keyframes blocks, so their from/to steps are not read as selectors, and returns the
// names they define. An animation-name that uses one of these names is what makes it move.
function stripKeyframes(css: string): { css: string; names: string[] } {
  const KEYFRAMES = /@keyframes\s+([\w-]+)\s*\{/;
  const names: string[] = [];
  let rest = css;
  let out = '';
  for (;;) {
    const m = KEYFRAMES.exec(rest);
    if (!m) break;
    names.push(m[1] ?? '');
    out += rest.slice(0, m.index);
    rest = rest.slice(closingBrace(rest, m.index + m[0].length - 1) + 1);
  }
  return { css: out + rest, names };
}

// Splits a list on commas outside parentheses, so cubic-bezier(0.4, 0, 0.2, 1) stays whole.
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of list) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function stripImportant(value: string): string {
  return value.replace(/\s*!\s*important\s*$/i, '').trim();
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
          return [d.slice(0, colon).trim(), stripImportant(d.slice(colon + 1))] as const;
        }),
    ),
  }));
}

// How each motion property is read. `time` lists are transitions and animations: a duration of
// zero (or `none`) means nothing moves. `delay` is off when every delay is zero. `name` is an
// animation-name: off only for `none`. `keyword` is scroll-behavior. `reset` names the shorthand
// that rewrites this longhand, so a reduced-motion shorthand also covers it.
type Kind = 'time' | 'delay' | 'name' | 'keyword';
const MOTION_PROPS: Record<string, { kind: Kind; reset?: string }> = {
  transition: { kind: 'time' },
  'transition-duration': { kind: 'time', reset: 'transition' },
  'transition-delay': { kind: 'delay', reset: 'transition' },
  animation: { kind: 'time' },
  'animation-duration': { kind: 'time', reset: 'animation' },
  'animation-name': { kind: 'name', reset: 'animation' },
  'scroll-behavior': { kind: 'keyword' },
};

const TIME = /^-?(\d+\.?\d*|\.\d+)(s|ms)$/;
const timesIn = (item: string): string[] => item.split(/\s+/).filter((t) => TIME.test(t));
const isZero = (time: string): boolean => parseFloat(time) === 0;

// One transition or animation item is off when it is `none`, or when every time in it is zero
// (its duration, and any delay). No time at all means the initial duration of 0s.
function timeItemOff(item: string): boolean {
  if (item.split(/\s+/).includes('none')) return true;
  return timesIn(item).every(isZero);
}

function isOff(prop: string, value: string): boolean {
  // A value we cannot resolve (a custom property) is treated as moving.
  if (value.includes('var(')) return false;
  const items = splitTopLevel(value);
  switch (MOTION_PROPS[prop]?.kind) {
    case 'keyword':
      return value === 'auto';
    case 'name':
      return items.every((item) => item === 'none');
    case 'delay':
      return items.every((item) => timesIn(item).every(isZero));
    case 'time':
      return items.every(timeItemOff);
    default:
      return false;
  }
}

// Whether a reduced-motion selector contains the selector being checked. `.app-frame *` matches
// the descendants of `.app-frame` but not `.app-frame` itself.
function covers(broad: string, selector: string): boolean {
  if (broad === selector || broad === '*') return true;
  if (broad.endsWith(' *')) return selector.startsWith(`${broad.slice(0, -2).trim()} `);
  return false;
}

// Every declaration a reduced-motion rule sets for `selector`, later rules winning.
function overridesFor(reduceRules: Rule[], selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of reduceRules) {
    if (!splitTopLevel(rule.selector).some((item) => covers(item, selector))) continue;
    for (const [prop, value] of rule.decls) merged.set(prop, value);
  }
  return merged;
}

function covered(prop: string, merged: Map<string, string>): boolean {
  const reset = MOTION_PROPS[prop]?.reset;
  return [prop, reset].some(
    (p) => p !== undefined && merged.has(p) && isOff(p, merged.get(p) ?? ''),
  );
}

// Every moving declaration in a stylesheet that no reduced-motion rule turns off. Returns one
// message per selector and property; an empty list means the stylesheet is covered.
function motionProblems(raw: string): string[] {
  const parts = splitReduceBlocks(stripComments(raw));
  const reduceRules = parseRules(stripKeyframes(parts.reduce).css);
  const problems: string[] = [];
  for (const rule of parseRules(stripKeyframes(parts.rest).css)) {
    const moving = [...rule.decls].filter(
      ([prop, value]) => MOTION_PROPS[prop] !== undefined && !isOff(prop, value),
    );
    if (moving.length === 0) continue;
    for (const selector of splitTopLevel(rule.selector)) {
      const merged = overridesFor(reduceRules, selector);
      for (const [prop, value] of moving) {
        if (!covered(prop, merged)) {
          problems.push(`${selector} sets ${prop}: ${value} with no reduced-motion override`);
        }
      }
    }
  }
  return problems;
}

const files = cssFiles(srcRoot).map((path) => ({
  name: relative(srcRoot, path).replaceAll('\\', '/'),
  css: readFileSync(path, 'utf8'),
}));

describe('reduced motion in the stylesheets', () => {
  it('finds the stylesheets (guards against an empty scan)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('keeps the reduced-motion rules in layout, feedback and the canvas pill', () => {
    for (const name of ['layout/layout.css', 'feedback/feedback.css', 'view/canvasPill.css']) {
      const file = files.find((f) => f.name === name);
      expect(file, name).toBeDefined();
      expect(splitReduceBlocks(stripComments(file?.css ?? '')).reduce.trim(), name).not.toBe('');
    }
  });

  for (const file of files) {
    it(`${file.name}: every moving rule has a reduced-motion override`, () => {
      expect(motionProblems(file.css).map((p) => `${file.name}: ${p}`)).toEqual([]);
    });
  }
});

// The check itself, on synthetic stylesheets, so each rule it relies on has a case that fails
// when that rule is broken.
const reduceBlock = (body: string) => `${REDUCE_OPEN}\n${body}\n}`;

describe('the motion check on synthetic stylesheets', () => {
  it('flags a transition with no reduced-motion override', () => {
    expect(motionProblems('.a { transition: opacity 200ms ease; }')).toHaveLength(1);
  });

  it.each([
    ['transition: opacity 0s', '.a { transition: opacity 0s; }'],
    ['transition: opacity 0ms', '.a { transition: opacity 0ms; }'],
    ['transition: opacity 0.0s', '.a { transition: opacity 0.0s; }'],
    ['transition: none', '.a { transition: none; }'],
    ['transition-duration: 0s', '.a { transition-duration: 0s; }'],
    ['animation-duration: 0s', '.a { animation-duration: 0s; }'],
    ['animation: spin 0s', '.a { animation: spin 0s; }'],
    ['animation: none', '.a { animation: none; }'],
    ['zero durations in a comma list', '.a { transition: opacity 0s, transform 0s; }'],
    ['a cubic-bezier with commas', '.a { transition: opacity 0s cubic-bezier(0.4, 0, 0.2, 1); }'],
    ['transition-delay: 0s', '.a { transition-delay: 0s; }'],
    ['scroll-behavior: auto', '.a { scroll-behavior: auto; }'],
  ])('treats %s as off', (_label, css) => {
    expect(motionProblems(css)).toEqual([]);
  });

  it('flags a zero duration that still has a delay, since the change jumps after it', () => {
    expect(motionProblems('.a { transition: opacity 0s 0.2s; }')).toHaveLength(1);
  });

  it('flags one moving item in a comma list even when the others are off', () => {
    expect(motionProblems('.a { transition: opacity 0s, transform 200ms; }')).toHaveLength(1);
  });

  it('does not treat transition-property alone as motion', () => {
    expect(motionProblems('.a { transition-property: opacity; }')).toEqual([]);
  });

  it('flags a non-zero transition-delay', () => {
    expect(motionProblems('.a { transition-delay: 0.3s; }')).toHaveLength(1);
  });

  it('flags an animation-name with no override, and accepts a shorthand or name override', () => {
    expect(motionProblems('.a { animation-name: spin; }')).toHaveLength(1);
    expect(
      motionProblems(`.a { animation-name: spin; }\n${reduceBlock('.a { animation: none; }')}`),
    ).toEqual([]);
    expect(
      motionProblems(
        `.a { animation-name: spin; }\n${reduceBlock('.a { animation-name: none; }')}`,
      ),
    ).toEqual([]);
  });

  it('reads @keyframes as a definition, not as selectors, and flags a use of it', () => {
    const keyframes =
      '@keyframes spin { from { transform: rotate(0); } to { transform: rotate(1turn); } }';
    expect(stripKeyframes(keyframes).names).toEqual(['spin']);
    expect(motionProblems(`${keyframes}\n.a { animation: spin 1s linear infinite; }`)).toHaveLength(
      1,
    );
    const overridden = `${keyframes}\n.a { animation: spin 1s linear infinite; }\n${reduceBlock(
      '.a { animation: none !important; }',
    )}`;
    expect(motionProblems(overridden)).toEqual([]);
  });

  it('flags a non-zero scroll-behavior', () => {
    expect(motionProblems('.a { scroll-behavior: smooth; }')).toHaveLength(1);
  });

  it('treats a broader reduced-motion selector as covering the selectors it contains', () => {
    const css = `.app-frame .toast { transition: opacity 200ms; }\n${reduceBlock(
      '.app-frame * { transition: none !important; }',
    )}`;
    expect(motionProblems(css)).toEqual([]);
  });

  it('does not let a broader selector cover its own element or a sibling', () => {
    const broad = reduceBlock('.app-frame * { transition: none !important; }');
    expect(motionProblems(`.app-frame { transition: opacity 200ms; }\n${broad}`)).toHaveLength(1);
    expect(motionProblems(`.other { transition: opacity 200ms; }\n${broad}`)).toHaveLength(1);
  });

  it('checks each selector of a comma list on its own', () => {
    const css = `.app-frame .x, .y { transition: opacity 1s; }\n${reduceBlock(
      '.app-frame * { transition: none; }',
    )}`;
    expect(motionProblems(css)).toEqual([
      '.y sets transition: opacity 1s with no reduced-motion override',
    ]);
  });

  it('covers a moving longhand by the reduced-motion value of that longhand', () => {
    const css = `.a { transition-duration: 200ms; }\n${reduceBlock('.a { transition-duration: 0s; }')}`;
    expect(motionProblems(css)).toEqual([]);
  });

  it('treats a custom property value as moving, since it cannot be resolved here', () => {
    expect(motionProblems('.a { transition: var(--motion) 0s; }')).toHaveLength(1);
  });

  it('keeps the reduced-motion block out of the rule scan, and reads the rest', () => {
    const css = `${reduceBlock('.a { transition: none; }')}\n.b { transition: opacity 200ms; }`;
    expect(splitReduceBlocks(css).reduce).toContain('.a { transition: none; }');
    expect(motionProblems(css)).toHaveLength(1);
  });
});
