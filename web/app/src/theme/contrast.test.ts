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
// Every surface a control or its text can sit on. The canvas is the page backdrop behind the
// document, so text and control edges drawn over it meet the same thresholds.
const ALL_SURFACES = ['canvas', ...SURFACES] as const;
const TEXT_TOKENS = ['text', 'textMuted', 'danger', 'success', 'warning'] as const;
const CONTROL_EDGES = ['border', 'borderStrong'] as const;

// textDisabled is deliberately not asserted: WCAG 1.4.3 exempts inactive controls. Its ratios
// are an open design decision (W8.5 brief section 6), recorded in the PR rather than enforced.

// Values deliberately below their threshold. Each entry is asserted as still failing, so the
// exception stays visible: a token change that makes the check pass makes its entry stale and
// fails the test, and the entry is then removed. Keys are the labels `check` builds.
// The reasons are open design decisions, not fixes: the tokens stay as they are, and each one is
// listed in the PR for the designer to confirm or change. Do not add an entry to hide a failure
// that a token change could fix; change the token instead.
const REASON_CANVAS_TEXT =
  'open decision: the text token is below 4.5:1 on the canvas backdrop; confirm whether it is ever drawn there';
const REASON_CANVAS_ACCENT_TEXT =
  'open decision: accent text is below 4.5:1 on the canvas backdrop; confirm whether it is ever drawn there';
const REASON_HAIRLINE =
  'open decision: the hairline border is a decorative divider and is below 3:1; controls are identified by their label and fill';
const REASON_STRONG_BORDER =
  'open decision: the strong control outline is below 3:1; WCAG 1.4.11 applies if it is the only cue for an input';
const REASON_DARK_ACCENT_ALT =
  'open decision: the dark preset accent fill is below 3:1 on surfaceAlt; confirm before release';

function exceptionsFor(reason: string, labels: string[]): Record<string, string> {
  return Object.fromEntries(labels.map((label) => [label, reason]));
}

const KNOWN_EXCEPTIONS: Record<string, string> = {
  ...exceptionsFor(REASON_CANVAS_TEXT, [
    'danger on canvas, light',
    'success on canvas, light',
    'warning on canvas, light',
  ]),
  ...exceptionsFor(
    REASON_HAIRLINE,
    ALL_SURFACES.flatMap((s) => [`border on ${s}, light`, `border on ${s}, dark`]),
  ),
  ...exceptionsFor(
    REASON_STRONG_BORDER,
    ALL_SURFACES.flatMap((s) => [`borderStrong on ${s}, light`, `borderStrong on ${s}, dark`]),
  ),
  ...exceptionsFor(
    REASON_CANVAS_ACCENT_TEXT,
    ACCENT_PRESETS.map((id) => `accentText on canvas, light, ${id}`),
  ),
  ...exceptionsFor(
    REASON_DARK_ACCENT_ALT,
    ACCENT_PRESETS.filter((id) => id !== 'blue').map((id) => `accent on surfaceAlt, dark, ${id}`),
  ),
};

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

// Asserts one check against its threshold, or, for a recorded exception, that it still fails.
function expectContrast(r: ReturnType<typeof check>): void {
  const exception = KNOWN_EXCEPTIONS[r.label];
  if (exception === undefined) {
    expect(r.ok, fail(r)).toBe(true);
    return;
  }
  expect(r.ok, `${r.label} now passes: remove its known exception (${exception})`).toBe(false);
}

describe('text tokens on surfaces (4.5:1)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(TEXT_TOKENS.flatMap((t) => ALL_SURFACES.map((s) => [t, s] as const)))(
      `${scheme} %s on %s`,
      (token, surface) => {
        const colours = COLOURS[scheme];
        expectContrast(
          check(`${token} on ${surface}, ${scheme}`, colours[token], colours[surface], TEXT_MIN),
        );
      },
    );
  }
});

describe('control and focus tokens (3:1 against their background)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(ALL_SURFACES)(`${scheme} focusRing on %s`, (surface) => {
      const colours = COLOURS[scheme];
      expectContrast(
        check(
          `focusRing on ${surface}, ${scheme}`,
          colours.focusRing,
          colours[surface],
          NON_TEXT_MIN,
        ),
      );
    });

    // The strong border outlines inputs and buttons; the hairline border divides panels. Both
    // sit on the same backgrounds as the focus ring.
    it.each(CONTROL_EDGES.flatMap((t) => ALL_SURFACES.map((s) => [t, s] as const)))(
      `${scheme} %s on %s (3:1)`,
      (token, surface) => {
        const colours = COLOURS[scheme];
        expectContrast(
          check(
            `${token} on ${surface}, ${scheme}`,
            colours[token],
            colours[surface],
            NON_TEXT_MIN,
          ),
        );
      },
    );

    it.each(ALL_SURFACES)(`${scheme} accent fill on %s (3:1)`, (surface) => {
      const colours = COLOURS[scheme];
      expectContrast(
        check(`accent on ${surface}, ${scheme}`, colours.accent, colours[surface], NON_TEXT_MIN),
      );
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

const PRESET_SURFACES = ACCENT_PRESETS.flatMap((id) => ALL_SURFACES.map((s) => [id, s] as const));

describe('accent presets', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it.each(ACCENT_PRESETS)(`${scheme} %s: onAccent on accent (4.5:1)`, (id) => {
      const t = accentTokens(id, scheme);
      expectContrast(check(`onAccent on accent, ${scheme}, ${id}`, t.onAccent, t.accent, TEXT_MIN));
    });

    it.each(PRESET_SURFACES)(`${scheme} %s on %s: accentText (4.5:1)`, (id, surface) => {
      const t = accentTokens(id, scheme);
      expectContrast(
        check(
          `accentText on ${surface}, ${scheme}, ${id}`,
          t.accentText,
          COLOURS[scheme][surface],
          TEXT_MIN,
        ),
      );
    });

    it.each(PRESET_SURFACES)(`${scheme} %s on %s: focusRing (3:1)`, (id, surface) => {
      const t = accentTokens(id, scheme);
      expectContrast(
        check(
          `focusRing on ${surface}, ${scheme}, ${id}`,
          t.focusRing,
          COLOURS[scheme][surface],
          NON_TEXT_MIN,
        ),
      );
    });

    it.each(PRESET_SURFACES)(`${scheme} %s on %s: accent fill (3:1)`, (id, surface) => {
      const t = accentTokens(id, scheme);
      expectContrast(
        check(
          `accent on ${surface}, ${scheme}, ${id}`,
          t.accent,
          COLOURS[scheme][surface],
          NON_TEXT_MIN,
        ),
      );
    });
  }
});
