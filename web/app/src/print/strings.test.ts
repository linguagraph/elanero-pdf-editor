import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the print components goes through t() (W6.5). The same two checks
// as the layout scan: text between JSX tags, and a literal in an attribute a reader announces.
const here = dirname(fileURLToPath(import.meta.url));
const FILES = ['PrintDialog.tsx'];
const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('print strings go through t()', () => {
  it.each(FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
