// The accent colour preset (W4.5 S4). Blue is the default and sets no attribute, so the default
// look is the `:root` values in tokens.css. Each other preset sets `data-accent`, and the generated
// blocks for it (tokens-css.ts) restyle the accent variables. The choice is stored with the other
// preferences in `elanero.prefs`; it is not a secret.
import { ACCENT_PRESETS, DEFAULT_ACCENT_ID, type AccentId } from './tokens';
import { readPreferences } from '../prefs/store';

export const ACCENT_CHOICES: readonly AccentId[] = ACCENT_PRESETS;

export function isAccentChoice(value: unknown): value is AccentId {
  return typeof value === 'string' && (ACCENT_CHOICES as readonly string[]).includes(value);
}

export function applyAccent(id: AccentId, root: HTMLElement = document.documentElement): void {
  if (id === DEFAULT_ACCENT_ID) {
    root.removeAttribute('data-accent');
  } else {
    root.setAttribute('data-accent', id);
  }
}

// Applies the saved accent before the first render, so the page does not flash the default blue.
// readPreferences never throws (a throwing localStorage gives the defaults), so this cannot fail.
export function initAccent(): AccentId {
  const id = readPreferences().accent;
  applyAccent(id);
  return id;
}
