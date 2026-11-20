import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { fakeEngine } from '../engine/testEngine';
import { t } from '../i18n/t';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { PREFS_STORAGE_KEY, readPreferences } from './store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<App engine={fakeEngine()} />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-accent');
});

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function openFromCommand(): HTMLElement {
  const button = [...host.querySelectorAll('button')].find(
    (b) => b.textContent === t('command.preferences.label'),
  );
  expect(button).toBeDefined();
  act(() => {
    button?.click();
  });
  const opened = dialog();
  expect(opened?.textContent).toContain(t('prefs.title'));
  return opened as HTMLElement;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function radio(scope: HTMLElement, label: string): HTMLInputElement {
  const found = [...scope.querySelectorAll('label')].find((l) => l.textContent === label);
  const input = found?.querySelector<HTMLInputElement>('input');
  if (input === undefined || input === null) throw new Error(`no radio ${label}`);
  return input;
}

// Sets a field the way a user's typing does: through the native setter, then an input or change
// event, so React's handlers see the new value.
function typeInto(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  act(() => {
    if (input instanceof HTMLSelectElement) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
        input,
        value,
      );
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

function authorInput(scope: HTMLElement): HTMLInputElement {
  const input = scope.querySelector<HTMLInputElement>('input[maxlength="64"]');
  if (input === null) throw new Error('no author input');
  return input;
}

function zoomSelect(scope: HTMLElement): HTMLSelectElement {
  const select = scope.querySelector<HTMLSelectElement>('select[id$="-zoom"]');
  if (select === null) throw new Error('no zoom select');
  return select;
}

// Escape goes to the dialog itself, the element react-aria listens on, as a key press inside it.
function pressEscape(): void {
  const target = dialog();
  expect(target).not.toBeNull();
  act(() => {
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

describe('PreferencesDialog', () => {
  it('opens from the Preferences command', () => {
    const scope = openFromCommand();
    expect(scope.querySelector('[slot="title"]')?.textContent).toBe(t('prefs.title'));
  });

  it('traps Tab inside the dialog', () => {
    const scope = openFromCommand();
    // The tab order runs through the form's controls and the two buttons, so the first and last
    // tab stops are the language select and Apply.
    const stops = [...scope.querySelectorAll<HTMLElement>('input, select, button')];
    const first = stops[0];
    const last = stops[stops.length - 1] as HTMLElement;
    act(() => {
      last.focus();
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(scope.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('closes on Escape without saving', () => {
    typeInto(authorInput(openFromCommand()), 'Ada');
    pressEscape();
    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull();
    expect(readPreferences().authorName).toBe('');
  });

  it('closes on Cancel without saving, and puts the saved theme back', () => {
    const scope = openFromCommand();
    act(() => {
      radio(scope, t('prefs.theme.dark')).click();
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    act(() => {
      buttonIn(scope, t('prefs.cancel')).click();
    });
    expect(dialog()).toBeNull();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('previews the accent at once, puts the saved one back on Cancel', () => {
    const scope = openFromCommand();
    act(() => {
      radio(scope, t('prefs.accent.teal')).click();
    });
    expect(document.documentElement.getAttribute('data-accent')).toBe('teal');
    act(() => {
      buttonIn(scope, t('prefs.cancel')).click();
    });
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false);
    expect(readPreferences().accent).toBe('blue');
  });

  it('saves the chosen accent on Apply', () => {
    const scope = openFromCommand();
    act(() => {
      radio(scope, t('prefs.accent.purple')).click();
    });
    act(() => {
      scope
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(document.documentElement.getAttribute('data-accent')).toBe('purple');
    expect(readPreferences().accent).toBe('purple');
  });

  it('changes the theme at once, and saves everything on Apply', () => {
    const scope = openFromCommand();
    act(() => {
      radio(scope, t('prefs.theme.light')).click();
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    typeInto(authorInput(scope), 'Ada Lovelace');
    typeInto(zoomSelect(scope), 'actual');
    act(() => {
      scope
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(dialog()).toBeNull();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(readPreferences()).toMatchObject({
      theme: 'light',
      authorName: 'Ada Lovelace',
      defaultZoom: 'actual',
    });
  });

  it('labels the compact ribbon checkbox through t(), and saves its choice on Apply', () => {
    const scope = openFromCommand();
    const label = [...scope.querySelectorAll('label')].find(
      (l) => l.textContent === t('prefs.ribbonCompact'),
    );
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(input).toBeDefined();
    expect(input?.checked).toBe(false);
    act(() => {
      input?.click();
    });
    expect(input?.checked).toBe(true);
    act(() => {
      scope
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(dialog()).toBeNull();
    expect(readPreferences().ribbonCompact).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}')).toMatchObject({
      ribbonCompact: true,
    });
  });

  it('starts each open from the saved preferences', () => {
    typeInto(authorInput(openFromCommand()), 'Draft');
    pressEscape();
    expect(authorInput(openFromCommand()).value).toBe('');
  });

  it('offers only the page layouts that exist, and saves the one chosen in Viewing', () => {
    const scope = openFromCommand();
    expect([...layoutSelect(scope).options].map((o) => o.value)).toEqual([
      'continuous',
      'single',
      'twoPage',
      'twoPageCover',
    ]);
    typeInto(layoutSelect(scope), 'twoPageCover');
    act(() => {
      scope
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(readPreferences().pageLayout).toBe('twoPageCover');
  });

  it('saves the redaction style on Apply, and nothing on Cancel (W4.5 S3)', () => {
    const scope = openFromCommand();
    const fill = scope.querySelector<HTMLInputElement>('input[type="color"]');
    expect(fill?.value).toBe('#000000');
    typeInto(fill as HTMLInputElement, '#ff8000');
    typeInto(overlayInput(scope), 'REDACTED');
    act(() => {
      buttonIn(scope, t('prefs.cancel')).click();
    });
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull();

    const reopened = openFromCommand();
    typeInto(
      reopened.querySelector<HTMLInputElement>('input[type="color"]') as HTMLInputElement,
      '#ff8000',
    );
    typeInto(overlayInput(reopened), 'REDACTED');
    act(() => {
      reopened
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(readPreferences()).toMatchObject({
      redactionFill: '#ff8000',
      redactionOverlayText: 'REDACTED',
      redactionTextColor: '#ffffff',
    });
  });
});

// The overlay text field, found by its label: its input is a sibling of the label in the field.
function overlayInput(scope: HTMLElement): HTMLInputElement {
  const label = [...scope.querySelectorAll('label')].find(
    (l) => l.textContent === t('prefs.redaction.overlayText'),
  );
  const input = label?.parentElement?.querySelector<HTMLInputElement>('input');
  if (input === undefined || input === null) throw new Error('no overlay text input');
  return input;
}

describe('Keyboard Shortcuts from Preferences and the app menu (W4.5 S2)', () => {
  it('opens above Preferences, keeps the unsaved draft, and Escape closes only the top one', () => {
    const scope = openFromCommand();
    typeInto(authorInput(scope), 'Draft');
    act(() => {
      buttonIn(scope, t('prefs.shortcuts.open')).click();
    });
    const shortcuts = topDialog();
    expect(shortcuts?.textContent).toContain(t('palette.shortcutsList'));
    expect(shortcuts?.querySelector('kbd')).not.toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);

    act(() => {
      shortcuts?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(authorInput(dialog() as HTMLElement).value).toBe('Draft');
  });

  it('the app menu command opens the shortcuts list (it no longer reads not available yet)', () => {
    const menu = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('appMenu.label')}"]`,
    );
    expect(menu).not.toBeNull();
    act(() => {
      menu?.click();
    });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === t('command.keyboard-shortcuts.label'),
    );
    expect(item).toBeDefined();
    act(() => {
      item?.click();
    });
    expect(topDialog()?.textContent).toContain(t('palette.shortcutsList'));
  });
});

function layoutSelect(scope: HTMLElement): HTMLSelectElement {
  const select = scope.querySelector<HTMLSelectElement>('select[id$="-layout"]');
  if (select === null) throw new Error('no layout select');
  return select;
}

// The dialog on top: react-aria stacks a later overlay after the earlier ones.
function topDialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[role="dialog"]');
  return all[all.length - 1] ?? null;
}
