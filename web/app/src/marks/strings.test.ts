import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN } from '../i18n/en';

// Every marks.* message id used in the marks code exists in the English catalogue (W4.7), and the
// marks components route their text through t() (checked by the dialog tests as they land).
const here = dirname(fileURLToPath(import.meta.url));
const SOURCE_FILES = readdirSync(here).filter(
  (name) => /\.tsx?$/.test(name) && !/\.test\./.test(name),
);

const MARK_KEY = /['"`](marks\.[A-Za-z0-9_.]+)['"`]/g;

// The engine's action and RPC names also start with marks. They are not message ids.
const NOT_MESSAGES = new Set([
  'marks.header_footer',
  'marks.watermark',
  'marks.background',
  'marks.remove',
  'marks.list',
]);

describe('marks strings', () => {
  it('scans the marks source files', () => {
    expect(SOURCE_FILES).toEqual(expect.arrayContaining(['marks.ts']));
  });

  it('uses only message ids that exist in en.ts', () => {
    const catalogue = new Set<string>(Object.keys(EN));
    const missing: string[] = [];
    for (const file of SOURCE_FILES) {
      const text = readFileSync(resolve(here, file), 'utf8');
      for (const match of text.matchAll(MARK_KEY)) {
        const key = match[1];
        if (key === undefined || NOT_MESSAGES.has(key)) continue;
        if (!catalogue.has(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('defines every marks key in en.ts with a non-empty text', () => {
    for (const [key, value] of Object.entries(EN)) {
      if (key.startsWith('marks.') && typeof value === 'string')
        expect(value.length, key).toBeGreaterThan(0);
    }
  });
});
