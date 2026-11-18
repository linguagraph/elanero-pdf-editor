import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the start page, the tab strip and the document shell goes through
// t() (W4.7). This scan catches the two ways a literal sneaks in: text between JSX tags, and a
// literal in an attribute a screen reader or a tooltip reads.
const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDERS = ['start', 'tabs', 'documents'];
const FILES = FOLDERS.flatMap((folder) =>
  readdirSync(resolve(srcDir, folder))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => `${folder}/${name}`),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('start page, tabs and document strings go through t()', () => {
  it('scans the components of all three folders', () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        'start/StartPage.tsx',
        'tabs/DocumentTabs.tsx',
        'documents/OpenInput.tsx',
        'documents/useDocuments.ts',
      ]),
    );
  });

  it.each(FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(srcDir, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
