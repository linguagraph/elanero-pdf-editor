// The single source of the web app's design tokens. `scripts/generate-tokens.ts` turns this
// module into `tokens.css` (custom properties on :root); components read only the variables,
// never a colour literal, so a change here reaches every screen in both schemes.
//
// Colours follow the desktop palette (`src/pdfeditor/ui/style/tokens.py`, Windows 11 defaults)
// so the two apps look alike. Dark values are used under `prefers-color-scheme: dark` unless
// the user picked Light, and under `data-theme="dark"` when the user picked Dark.

export type ColourToken =
  | 'window'
  | 'surface'
  | 'surfaceAlt'
  | 'canvas'
  | 'border'
  | 'borderStrong'
  | 'text'
  | 'textMuted'
  | 'textDisabled'
  | 'accent'
  | 'onAccent'
  | 'accentText'
  | 'focusRing'
  | 'danger'
  | 'success'
  | 'warning'
  | 'brand';

export const BRAND = {
  name: 'Elanero',
} as const;

export const COLOURS: Record<'light' | 'dark', Record<ColourToken, string>> = {
  light: {
    window: '#f3f3f3',
    surface: '#ffffff',
    surfaceAlt: '#f9f9f9',
    canvas: '#d4d5d7',
    border: '#e0e0e0',
    borderStrong: '#c2c2c2',
    text: '#1b1b1b',
    textMuted: '#5c5c5c',
    textDisabled: '#a0a0a0',
    accent: '#0067c0',
    onAccent: '#ffffff',
    accentText: '#0067c0',
    focusRing: '#0067c0',
    danger: '#c42b1c',
    success: '#0f7b0f',
    warning: '#8a5100',
    brand: '#0067c0',
  },
  dark: {
    window: '#202020',
    surface: '#2b2b2b',
    surfaceAlt: '#323232',
    canvas: '#141414',
    border: '#3b3b3b',
    borderStrong: '#5a5a5a',
    text: '#f3f3f3',
    textMuted: '#b4b4b4',
    textDisabled: '#6e6e6e',
    accent: '#4cc2ff',
    onAccent: '#000000',
    accentText: '#4cc2ff',
    focusRing: '#4cc2ff',
    danger: '#ff99a4',
    success: '#6ccb5f',
    warning: '#fce100',
    brand: '#4cc2ff',
  },
};

// Scheme-independent metrics. Spacing is a 4 px scale: --space-1 is 4 px, --space-2 is 8 px, …
export const SPACE_UNIT_PX = 4;
export const SPACE_STEPS = 6;

export const RADII_PX = {
  small: 4,
  base: 6,
  large: 8,
} as const;

export const FONT_SIZES_PX = {
  small: 12,
  body: 14,
  title: 20,
} as const;

// Minimum window widths (inclusive) for each layout tier, from W1.6 section 8. CSS media queries
// cannot read custom properties, so the layout reads these numbers in TypeScript (layout/breakpoints.ts)
// and the CSS variables exist for reference and for other stylesheets.
export const BREAKPOINTS_PX = {
  wide: 1280,
  medium: 1024,
  tablet: 768,
} as const;

// Side rail and panel widths. The panels take the desktop's defaults (ui/main_window.py: 220 px on
// the left, 260 px on the right), can be resized down to 160 px, and are remembered per side. The
// rail is 48 px so its 44 px touch targets fit with a margin.
export const LAYOUT_PX = {
  railWidth: 48,
  leftPanelWidth: 220,
  rightPanelWidth: 260,
  minPanelWidth: 160,
} as const;

// Accent presets (W4.5 S4), in the desktop's ACCENT_PRESETS order. Blue is the default and keeps
// the values in COLOURS (the web's dark blue, not the desktop's, per W4.5 D1), so it has no block
// in the generated CSS. The other seven come from the desktop's build_colors (the drift test in
// tests/unit/test_web_accent_tokens.py checks them), with focusRing equal to accentText as today.
export const ACCENT_PRESETS = [
  'blue',
  'teal',
  'green',
  'purple',
  'pink',
  'red',
  'orange',
  'graphite',
] as const;
export type AccentId = (typeof ACCENT_PRESETS)[number];
export const DEFAULT_ACCENT_ID = 'blue' as const;

export type AccentPresetId = Exclude<AccentId, typeof DEFAULT_ACCENT_ID>;

export interface AccentTokens {
  readonly accent: string;
  readonly onAccent: string;
  readonly accentText: string;
  readonly focusRing: string;
}

export const ACCENT_COLOURS: Record<AccentPresetId, Record<'light' | 'dark', AccentTokens>> = {
  teal: {
    light: { accent: '#038387', onAccent: '#ffffff', accentText: '#037c80', focusRing: '#037c80' },
    dark: { accent: '#038387', onAccent: '#000000', accentText: '#4ca7aa', focusRing: '#4ca7aa' },
  },
  green: {
    light: { accent: '#107c10', onAccent: '#ffffff', accentText: '#107c10', focusRing: '#107c10' },
    dark: { accent: '#238623', onAccent: '#000000', accentText: '#64aa64', focusRing: '#64aa64' },
  },
  purple: {
    light: { accent: '#8764b8', onAccent: '#ffffff', accentText: '#805faf', focusRing: '#805faf' },
    dark: { accent: '#8764b8', onAccent: '#000000', accentText: '#a78ecb', focusRing: '#a78ecb' },
  },
  pink: {
    light: { accent: '#c30052', onAccent: '#ffffff', accentText: '#c30052', focusRing: '#c30052' },
    dark: { accent: '#d03878', onAccent: '#000000', accentText: '#e07aa5', focusRing: '#e07aa5' },
  },
  red: {
    light: { accent: '#c42b1c', onAccent: '#ffffff', accentText: '#c42b1c', focusRing: '#c42b1c' },
    dark: { accent: '#cc473a', onAccent: '#000000', accentText: '#dc8077', focusRing: '#dc8077' },
  },
  orange: {
    light: { accent: '#ca5010', onAccent: '#ffffff', accentText: '#be4b0f', focusRing: '#be4b0f' },
    dark: { accent: '#ca5010', onAccent: '#000000', accentText: '#da8458', focusRing: '#da8458' },
  },
  graphite: {
    light: { accent: '#5d6b7a', onAccent: '#ffffff', accentText: '#5d6b7a', focusRing: '#5d6b7a' },
    dark: { accent: '#6a7785', onAccent: '#000000', accentText: '#929ca6', focusRing: '#929ca6' },
  },
};

// The light fill of each preset (Blue's is COLOURS.light.accent), for the swatches in Preferences.
export function accentSwatch(id: AccentId): string {
  if (id === DEFAULT_ACCENT_ID) return COLOURS.light.accent;
  return ACCENT_COLOURS[id].light.accent;
}
