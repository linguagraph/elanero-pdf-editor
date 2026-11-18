import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the feedback components goes through t() (W4.7). Same scan as the
// layout components: text between JSX tags, and literals in attributes a screen reader or a
// tooltip reads. Class names and ids are not user text, so they are not scanned.
const here = dirname(fileURLToPath(import.meta.url));
const COMPONENT_FILES = readdirSync(here).filter(
  (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('feedback strings go through t()', () => {
  it('scans at least the feedback components', () => {
    expect(COMPONENT_FILES).toEqual(
      expect.arrayContaining([
        'ToastRegion.tsx',
        'JobProgress.tsx',
        'LoadingScreen.tsx',
        'NotRespondingDialog.tsx',
      ]),
    );
  });

  it.each(COMPONENT_FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
