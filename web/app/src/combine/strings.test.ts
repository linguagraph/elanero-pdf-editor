import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the combine dialog goes through t() (W6.3). This scan catches the two
// ways a literal sneaks in: text between JSX tags, and a literal in an attribute a screen reader or
// a tooltip reads. Class names and accept lists are not user text, so they are not scanned. Only the
// components are scanned: the pure modules hold no user text.
const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT_FILES = readdirSync(here).filter(
  (name) => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('combine strings go through t()', () => {
  it('scans the dialog component', () => {
    expect(COMPONENT_FILES).toEqual(expect.arrayContaining(['CombineDialog.tsx']));
  });

  it.each(COMPONENT_FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
