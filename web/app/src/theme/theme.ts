// The user's colour scheme choice. "system" leaves the attribute off, so the CSS follows
// `prefers-color-scheme` live; "light" and "dark" set `data-theme` on <html>.
export const THEME_CHOICES = ['system', 'light', 'dark'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_STORAGE_KEY = 'elanero.theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

// localStorage can be missing or throw (private windows, blocked site data, a full quota).
// The theme then just is not remembered; the app still runs with the system scheme.
export function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function storeTheme(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Not remembered; the choice still applies for this page view.
  }
}

export function applyTheme(
  choice: ThemeChoice,
  root: HTMLElement = document.documentElement,
): void {
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

// Applies the stored choice before the first render, so the page does not flash the wrong scheme.
export function initTheme(): ThemeChoice {
  const choice = readStoredTheme();
  applyTheme(choice);
  return choice;
}

export function setTheme(choice: ThemeChoice): void {
  storeTheme(choice);
  applyTheme(choice);
}
