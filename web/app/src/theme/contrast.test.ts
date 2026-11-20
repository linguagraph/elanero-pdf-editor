import { describe, expect, it } from 'vitest';
import { ACCENT_COLOURS, ACCENT_PRESETS, COLOURS, type AccentId } from './tokens';

// WCAG 2.x contrast at the source (W8.5 S2): every text and control colour token is checked
// against the surfaces it sits on, in both schemes and for every accent preset. jsdom has no
// layout, so the browser checks (W8.5 S3 and S5) cover the rest.

type Scheme = 'light' | 'dark';

// WCAG 2.x relative luminance and contrast ratio (the same formula as tokens.test.ts and the
// desktop's tokens.py).
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

// Text needs 4.5:1 (WCAG 1.4.3); the focus indicator and UI boundaries need 3:1 (WCAG 1.4.11
// and 2.4.11/2.4.13 as used in W1.6 section 8).
const TEXT_MIN = 4.5;
const NON_TEXT_MIN = 3;

const SURFACES = ['window', 'surface', 'surfaceAlt'] as const;
const TEXT_TOKENS = ['text', 'textMuted', 'danger', 'success', 'warning'] as const;

// textDisabled is deliberately not asserted: WCAG 1.4.3 exempts inactive controls. Its ratios
// are an open design decision (W8.5 brief section 6), recorded in the PR rather than enforced.

function check(
  label: string,
  fg: string,
  bg: string,
  min: number,
): { label: string; ratio: number; min: number; ok: boolean } {
  const ratio = contrast(fg, bg);
  return { label, ratio, min, ok: ratio >= min };
}

function fail(result: { label: string; ratio: number; min: number }): string {
  return `contrast(${result.label}) = ${result.ratio.toFixed(2)} < ${result.min}`;
}

describe('text tokens on surfaces (4.5:1)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(TEXT_TOKENS.flatMap((t) => SURFACES.map((s) => [t, s] as const)))(
      `${scheme} %s on %s`,
      (token, surface) => {
        const colours = COLOURS[scheme];
        const r = check(
          `${token} on ${surface}, ${scheme}`,
          colours[token],
          colours[surface],
          TEXT_MIN,
        );
        expect(r.ok, fail(r)).toBe(true);
      },
    );
  }
});

describe('control and focus tokens (3:1 against their background)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(['canvas', ...SURFACES] as const)(`${scheme} focusRing on %s`, (surface) => {
      const colours = COLOURS[scheme];
      const r = check(
        `focusRing on ${surface}, ${scheme}`,
        colours.focusRing,
        colours[surface],
        NON_TEXT_MIN,
      );
      expect(r.ok, fail(r)).toBe(true);
    });
  }
});

// Every accent preset: Blue keeps its values in COLOURS, the others in ACCENT_COLOURS.
function accentTokens(id: AccentId, scheme: Scheme) {
  if (id === 'blue') {
    const c = COLOURS[scheme];
    return {
      accent: c.accent,
      onAccent: c.onAccent,
      accentText: c.accentText,
      focusRing: c.focusRing,
    };
  }
  return ACCENT_COLOURS[id][scheme];
}

describe('accent presets', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(ACCENT_PRESETS)(`${scheme} %s: onAccent on accent (4.5:1)`, (id) => {
      const t = accentTokens(id, scheme);
      const r = check(`onAccent on accent, ${scheme}, ${id}`, t.onAccent, t.accent, TEXT_MIN);
      expect(r.ok, fail(r)).toBe(true);
    });

    it.each(ACCENT_PRESETS)(`${scheme} %s: accentText on each surface (4.5:1)`, (id) => {
      const t = accentTokens(id, scheme);
      for (const surface of SURFACES) {
        const r = check(
          `accentText on ${surface}, ${scheme}, ${id}`,
          t.accentText,
          COLOURS[scheme][surface],
          TEXT_MIN,
        );
        expect(r.ok, fail(r)).toBe(true);
      }
    });

    it.each(ACCENT_PRESETS)(`${scheme} %s: focusRing on each surface (3:1)`, (id) => {
      const t = accentTokens(id, scheme);
      for (const surface of ['canvas', ...SURFACES] as const) {
        const r = check(
          `focusRing on ${surface}, ${scheme}, ${id}`,
          t.focusRing,
          COLOURS[scheme][surface],
          NON_TEXT_MIN,
        );
        expect(r.ok, fail(r)).toBe(true);
      }
    });
  }
});
