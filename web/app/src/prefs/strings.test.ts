import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Every user-facing string in the preferences folder goes through t() (W4.7). The scan catches the
// two ways a literal sneaks in: text between JSX tags, and a literal in an attribute a screen reader
// or a tooltip reads. Class names, ids and storage keys are not user text, so they are not scanned.
const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_FILES = readdirSync(here).filter(
  (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
);

const JSX_TEXT = />([^<>{}\n]*\p{L}[^<>{}\n]*)</gu;
const READABLE_ATTRIBUTE =
  /\b(aria-label|aria-description|title|alt|placeholder)=("[^"]*"|'[^']*')/g;

describe('preferences strings go through t()', () => {
  it('scans the dialog and the store', () => {
    expect(SOURCE_FILES).toEqual(expect.arrayContaining(['PreferencesDialog.tsx', 'store.ts']));
  });

  it.each(SOURCE_FILES)('%s has no literal user text', (file) => {
    const text = readFileSync(resolve(here, file), 'utf8');
    expect([...text.matchAll(JSX_TEXT)].map((m) => m[1])).toEqual([]);
    expect([...text.matchAll(READABLE_ATTRIBUTE)].map((m) => m[0])).toEqual([]);
  });
});
