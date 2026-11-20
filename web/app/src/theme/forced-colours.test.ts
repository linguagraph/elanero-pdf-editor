import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, 'tokens.css'), 'utf8');

// The CSS system colour keywords the forced-colours block may use (CSS Color 4, section 6.2).
const SYSTEM_COLOURS = new Set([
  'CanvasText',
  'Canvas',
  'LinkText',
  'ButtonText',
  'ButtonFace',
  'Highlight',
  'HighlightText',
  'GrayText',
]);

// The block runs from its opening line to the first line that is exactly "}" (its closing brace).
function forcedBlock(): string {
  const start = css.indexOf('@media (forced-colors: active) {');
  expect(start, 'forced-colors block exists').toBeGreaterThan(-1);
  const end = css.indexOf('\n}\n', start);
  return css.slice(start, end + 3);
}

function declarations(text: string): Array<[string, string]> {
  return [...text.matchAll(/^\s*([a-z-]+): ([^;]+);/gm)].map((m) => [
    m[1] ?? '',
    (m[2] ?? '').trim(),
  ]);
}

describe('forced-colours block', () => {
  it('is in the generated stylesheet, after the dark blocks so it wins', () => {
    expect(forcedBlock()).toContain(':root:root {');
    expect(css.indexOf('@media (forced-colors: active)')).toBeGreaterThan(
      css.indexOf(":root[data-theme='dark']"),
    );
  });

  it('sets every colour token to a system colour keyword only', () => {
    const colours = declarations(forcedBlock()).filter(([prop]) => prop.startsWith('--color-'));
    expect(colours.length).toBeGreaterThanOrEqual(16);
    for (const [prop, value] of colours) {
      expect(SYSTEM_COLOURS.has(value), `${prop}: ${value}`).toBe(true);
    }
  });

  it('keeps the focus outline visible with a system colour', () => {
    const block = forcedBlock();
    expect(block).toContain(':focus-visible {');
    const outline = declarations(block).find(([prop]) => prop === 'outline');
    expect(outline).toBeDefined();
    const words = (outline?.[1] ?? '').split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w));
    expect(words).toContain('CanvasText');
    for (const word of words) {
      expect(['solid', ...SYSTEM_COLOURS]).toContain(word);
    }
    expect(declarations(block)).toContainEqual(['outline-offset', '2px']);
  });

  it('comes after the accent presets, so an accent never overrides it', () => {
    expect(css.indexOf('data-accent=')).toBeGreaterThan(-1);
    expect(css.lastIndexOf('data-accent=')).toBeLessThan(
      css.indexOf('@media (forced-colors: active)'),
    );
    expect(forcedBlock()).not.toContain('data-accent');
  });

  it('never removes an outline or uses a colour literal inside the block', () => {
    const block = forcedBlock();
    expect(block).not.toMatch(/outline:\s*(none|0)\b/);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
  });
});
