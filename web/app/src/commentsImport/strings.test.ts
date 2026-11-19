import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the comment import dialog goes through t() (W4.7).
const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT_FILES = readdirSync(here).filter(
  (name) => /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('comment import dialog strings go through t()', () => {
  it.each(COMPONENT_FILES)('%s has no literal user text', (name) => {
    const text = readFileSync(resolve(here, name), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((match) => match[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((match) => match[0])).toEqual([]);
  });
});
