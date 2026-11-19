import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the comment tools goes through t() (W4.7), as in the document view.
const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT_FILES = readdirSync(here).filter(
  (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('comment tools strings go through t()', () => {
  it('scans the comment components', () => {
    expect(COMPONENT_FILES).toEqual(
      expect.arrayContaining(['CommentLayer.tsx', 'CommentToolbar.tsx']),
    );
  });

  it.each(COMPONENT_FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
