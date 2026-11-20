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
