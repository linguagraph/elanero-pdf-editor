import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCENT_COLOURS, ACCENT_PRESETS, COLOURS, type AccentId } from './tokens';
import { renderTokensCss } from './tokens-css';

// WCAG 2.x relative luminance and contrast ratio (the same formula as the desktop's tokens.py).
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((s) =>
    s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

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
  'theme/BrandMark.tsx',
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

describe('accent presets (W4.5 S4)', () => {
  const presets = ACCENT_PRESETS.filter((id): id is Exclude<AccentId, 'blue'> => id !== 'blue');
  // The accent region runs from the forced-colours: none group to its closing line at column 0.
  const start = committedCss.indexOf('@media (forced-colors: none) {');
  const end = committedCss.indexOf('\n}\n', start);

  it('has one light and two dark blocks per non-blue preset, and none for Blue', () => {
    expect(start).toBeGreaterThan(-1);
    expect(committedCss).not.toContain("data-accent='blue'");
    for (const id of presets) {
      const light = `:root[data-accent='${id}'] {`;
      const dark = `:root:not([data-theme='light'])[data-accent='${id}'] {`;
      const darkForced = `:root[data-theme='dark'][data-accent='${id}'] {`;
      expect(committedCss.split(light).length - 1, light).toBe(1);
      expect(committedCss.split(dark).length - 1, dark).toBe(1);
      expect(committedCss.split(darkForced).length - 1, darkForced).toBe(1);
    }
  });

  it('keeps every accent block inside @media (forced-colors: none)', () => {
    for (const match of committedCss.matchAll(/data-accent=/g)) {
      const at = match.index ?? -1;
      expect(at > start && at < end, `data-accent at ${at}`).toBe(true);
    }
  });

  it('gives every swatch variable, Blue included', () => {
    for (const id of ACCENT_PRESETS) {
      expect(committedCss).toMatch(new RegExp(`--accent-swatch-${id}: #[0-9a-f]{6};`));
    }
  });

  it.each(presets)('%s keeps onAccent and accentText readable in both schemes', (id) => {
    for (const scheme of ['light', 'dark'] as const) {
      const tokens = ACCENT_COLOURS[id][scheme];
      const surfaces = [COLOURS[scheme].surface, COLOURS[scheme].window];
      expect(
        contrast(tokens.onAccent, tokens.accent),
        `${id} ${scheme} on accent`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const bg of surfaces) {
        expect(
          contrast(tokens.accentText, bg),
          `${id} ${scheme} text on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('component colours', () => {
  it.each(TOKEN_FREE_FILES)('%s has no colour literal (colours come from tokens)', (file) => {
    const text = readFileSync(resolve(srcRoot, file), 'utf8');
    expect(text.match(COLOUR_LITERAL)).toBeNull();
  });
});
