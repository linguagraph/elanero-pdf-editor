import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the split dialog goes through t() (W4.7). This scan catches the two
// ways a literal sneaks in: text between JSX tags, and a literal in an attribute a screen reader
// or a tooltip reads. Class names and ids are not user text, so they are not scanned.
const here = dirname(fileURLToPath(import.meta.url));
// Only the component has JSX; the logic files hold no text the user reads.
const FILES = ['SplitDialog.tsx'].map((name) => resolve(here, name));

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('split dialog strings go through t()', () => {
  it.each(FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(file, 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((match) => match[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((match) => match[0])).toEqual([]);
  });
});
