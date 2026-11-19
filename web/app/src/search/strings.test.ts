import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the search panel and the text layer goes through t() (W4.7). This scan
// catches the two ways a literal sneaks in: text between JSX tags, and a literal in an attribute a
// screen reader or a tooltip reads. Class names and ids are not user text, so they are not scanned.
const here = dirname(fileURLToPath(import.meta.url));
const textDir = resolve(here, '../text');

const FILES = [
  ...readdirSync(here)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => resolve(here, name)),
  ...readdirSync(textDir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => resolve(textDir, name)),
];

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('search and text layer strings go through t()', () => {
  it('scans the search and text components', () => {
    expect(FILES.map((file) => file.split(/[\\/]/).pop())).toEqual(
      expect.arrayContaining(['SearchPanel.tsx', 'PageTextLayer.tsx']),
    );
  });

  it.each(FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(file, 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
