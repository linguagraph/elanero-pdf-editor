import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN } from './en';

// One scan for the whole app (W4.7 S5), in place of a copy per folder. Every user-facing string in
// src goes through t() or tp(): text between JSX tags, and a literal in an attribute that a screen
// reader or a tooltip reads, are rejected. The scan also keeps the catalogue honest: a key in en.ts
// that no source file names is dead text, and a cast to a key type skips the check tsc makes.
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Generated or data-only files: their literals are not screen text. Everything else is scanned,
// including theme/ (the theme switch and the brand mark show text).
const NOT_SCANNED = [
  'i18n/en.ts',
  'rpc/generated.ts',
  'theme/tokens.ts',
  'theme/tokens-css.ts',
  'theme/icons.generated.ts',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const ALL_SOURCE = walk(srcDir)
  .filter((path) => /\.tsx?$/.test(path))
  .map((path) => ({ path, file: relative(srcDir, path).split(sep).join('/') }));

const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file);
const SCANNED = ALL_SOURCE.filter(({ file }) => !isTest(file) && !NOT_SCANNED.includes(file));

// Text between tags. A `{...}` expression inside it is a value or a t() call, so it is blanked
// before the letters are checked: "Page {page} of {total}" is still text that must come from t().
const JSX_TEXT = />([^<>\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;
const KEY_CAST = /\bas\s+(MessageId|PluralId|AnyMessageId)\b/g;

function blankExpressions(text: string): string {
  let out = text;
  let previous: string;
  do {
    previous = out;
    out = out.replace(/\{[^{}]*\}/g, ' ');
  } while (out !== previous);
  return out;
}

// Each allowed literal names its file and the exact text, and says why it is not user text. It
// starts empty: a new entry needs a reason a reviewer can check.
interface Allowed {
  readonly file: string;
  readonly text: string;
  readonly reason: string;
}
const ALLOWED_LITERALS: readonly Allowed[] = [];

const UNUSED_ALLOWED: Readonly<Record<string, string>> = {
  'security.owner.title':
    'the owner step sits under the dialog title, so no separate title is shown (W7.5 S4)',
  'sample.pages':
    'test-only plural sample: i18n.test.ts and locale.test.ts exercise the plural rules with it',
  'engine.restart.title': 'catalogue text for the engine restart dialog, not yet built',
  'engine.restart.body': 'catalogue text for the engine restart dialog, not yet built',
  'view.zoomLabel': 'catalogue text for the zoom controls label, not yet built',
  'view.actualSize': 'catalogue text for the actual-size control, not yet built',
  'bookmarks.expand': 'catalogue text for the bookmark tree toggle, not yet built',
  'bookmarks.collapse': 'catalogue text for the bookmark tree toggle, not yet built',
};

// The literal texts a file shows: text between tags (in .tsx only, since in .ts a `>` and a `<`
// are generics) and the readable attributes (in both).
function literalsIn(text: string, jsx: boolean): string[] {
  const found: string[] = [];
  if (jsx) {
    for (const match of text.matchAll(JSX_TEXT)) {
      const visible = blankExpressions(match[1] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (/\p{L}/u.test(visible)) found.push(visible);
    }
  }
  for (const match of text.matchAll(READABLE_ATTRIBUTE)) found.push(match[0]);
  return found;
}

function isAllowed(file: string, literal: string): boolean {
  return ALLOWED_LITERALS.some((entry) => entry.file === file && literal.includes(entry.text));
}

describe('the string scan itself', () => {
  it('finds text between tags, mixed text and literal attributes', () => {
    expect(literalsIn('<p>Hello there</p>', true)).toEqual(['Hello there']);
    expect(literalsIn('<p>Page {page} of {total}</p>', true)).toEqual(['Page of']);
    expect(literalsIn('<button title="Save">x</button>', true)).toEqual(['x', 'title="Save"']);
    expect(literalsIn('<img alt="Logo" />', false)).toEqual(['alt="Logo"']);
  });

  it('ignores JSX expressions, text without letters, and generics in .ts', () => {
    expect(literalsIn('<p>{t("a.b")}</p>', true)).toEqual([]);
    expect(literalsIn('<p>{t("a.b", { n: 1 })}</p>', true)).toEqual([]);
    expect(literalsIn('<p>12 / 3</p>', true)).toEqual([]);
    expect(literalsIn('const m: Map<string, Promise<T>> = new Map();', false)).toEqual([]);
  });

  it('reads the whole source tree, theme included', () => {
    expect(SCANNED.map(({ file }) => file)).toEqual(
      expect.arrayContaining([
        'start/StartPage.tsx',
        'tabs/DocumentTabs.tsx',
        'App.tsx',
        'theme/ThemeSwitch.tsx',
      ]),
    );
  });
});

describe('user-facing text goes through t() and tp()', () => {
  it('has no literal text between JSX tags or in a readable attribute', () => {
    const problems: string[] = [];
    for (const { path, file } of SCANNED) {
      const text = readFileSync(path, 'utf8');
      for (const literal of literalsIn(text, file.endsWith('.tsx'))) {
        if (!isAllowed(file, literal)) problems.push(`${file}: ${literal}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('keeps the allowlist to entries that still match a literal', () => {
    const stale = ALLOWED_LITERALS.filter(
      (entry) =>
        !literalsIn(
          readFileSync(resolve(srcDir, entry.file), 'utf8'),
          entry.file.endsWith('.tsx'),
        ).some((literal) => literal.includes(entry.text)),
    );
    expect(stale.map((entry) => `${entry.file}: ${entry.text}`)).toEqual([]);
  });
});

describe('the catalogue keys are used as typed', () => {
  it('has no cast to a key type outside tests', () => {
    const casts: string[] = [];
    for (const { path, file } of ALL_SOURCE) {
      if (isTest(file)) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(KEY_CAST)) {
        casts.push(`${file}: ${match[0]}`);
      }
    }
    expect(casts).toEqual([]);
  });

  it('names every key in en.ts in some non-test source file, or says why not', () => {
    // Generated files count here too: a key named there is still in use.
    const named = ALL_SOURCE.filter(({ file }) => !isTest(file) && file !== 'i18n/en.ts');
    const sources = named.map(({ path }) => readFileSync(path, 'utf8')).join('\n');
    const unused = Object.keys(EN).filter((key) => {
      const quoted = new RegExp(`['"\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
      return !quoted.test(sources);
    });
    const dead = unused.filter((key) => !(key in UNUSED_ALLOWED));
    const stale = Object.keys(UNUSED_ALLOWED).filter((key) => !unused.includes(key));
    expect(dead).toEqual([]);
    expect(stale).toEqual([]);
  });
});
