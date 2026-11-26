import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COLOURS } from './tokens';

// Issue #744: WebKit gives an unstyled native button a light grey face with white text under
// color-scheme: dark (1.8:1). app.css gives native buttons the themed surface and text in dark
// mode only, under the same two selectors tokens.css uses for the dark palette.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../app.css'), 'utf8');

const DARK_MEDIA_SELECTOR = ":root:not([data-theme='light']) button";
const DARK_ATTR_SELECTOR = ":root[data-theme='dark'] button";

// The declarations inside the rule whose selector line is exactly `selector {`.
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThan(-1);
  const end = css.indexOf('}', start);
  return css.slice(start + selector.length + 2, end);
}

function declarations(body: string): Array<[string, string]> {
  return [...body.matchAll(/([a-z-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? '', (m[2] ?? '').trim()]);
}

// WCAG 2.x relative luminance and contrast ratio (the same formula as contrast.test.ts).
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

describe('native button defaults in dark mode (#744)', () => {
  it('sits in the base layer, so component colours still win', () => {
    expect(css.indexOf('@layer base {')).toBeGreaterThan(-1);
    expect(css.indexOf(DARK_MEDIA_SELECTOR)).toBeGreaterThan(css.indexOf('@layer base {'));
  });

  it.each([
    ['prefers-color-scheme', DARK_MEDIA_SELECTOR],
    ['data-theme', DARK_ATTR_SELECTOR],
  ])('sets the themed surface and text under the %s dark selector', (_name, selector) => {
    const decls = declarations(ruleBody(selector));
    expect(decls).toContainEqual(['background-color', 'var(--color-surface-alt)']);
    expect(decls).toContainEqual(['color', 'var(--color-text)']);
    expect(decls).toContainEqual(['border', '1px solid var(--color-border-strong)']);
  });

  it('dims disabled buttons with the disabled text token', () => {
    expect(css).toContain(`${DARK_MEDIA_SELECTOR}:disabled {`);
    expect(css).toContain(`${DARK_ATTR_SELECTOR}:disabled {`);
    expect(declarations(ruleBody(`${DARK_ATTR_SELECTOR}:disabled`))).toContainEqual([
      'color',
      'var(--color-text-disabled)',
    ]);
  });

  it('uses dark-palette text on the surface-alt face at least 4.5:1', () => {
    const dark = COLOURS.dark;
    expect(contrast(dark.text, dark.surfaceAlt)).toBeGreaterThanOrEqual(4.5);
  });
});
