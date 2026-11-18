import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLOURS } from './tokens';
import { renderTokensCss } from './tokens-css';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..');
const committedCss = readFileSync(resolve(here, 'tokens.css'), 'utf8');

// Files whose colours must all come from tokens.css (the components this task touched).
const TOKEN_FREE_FILES = [
  'App.tsx',
  'app.css',
  'main.tsx',
  'theme/ThemeSwitch.tsx',
  'theme/ThemeSwitch.css',
  'theme/icons.tsx',
  'theme/theme.ts',
];
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

describe('tokens.css', () => {
  it('matches the generator output (run `npm run tokens` after changing tokens.ts)', () => {
    expect(committedCss).toBe(renderTokensCss());
  });

  it('applies dark values under the system preference, guarded by the user choice', () => {
    expect(committedCss).toContain(
      "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {",
    );
    expect(committedCss).toContain(":root[data-theme='dark'] {");
  });

  it('defines every colour token for both schemes, and the brand colour', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [token, value] of Object.entries(COLOURS[scheme])) {
        const name = `--color-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        expect(committedCss, `${scheme} ${name}`).toContain(`${name}: ${value};`);
      }
    }
    expect(committedCss).toContain('--color-brand:');
  });
});

describe('component colours', () => {
  it.each(TOKEN_FREE_FILES)('%s has no colour literal (colours come from tokens)', (file) => {
    const text = readFileSync(resolve(srcRoot, file), 'utf8');
    expect(text.match(COLOUR_LITERAL)).toBeNull();
  });
});
