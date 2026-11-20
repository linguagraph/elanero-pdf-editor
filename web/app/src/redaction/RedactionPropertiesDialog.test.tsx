import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { PREFS_STORAGE_KEY, readPreferences } from '../prefs/store';
import { RedactionPropertiesDialog } from './RedactionPropertiesDialog';

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
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function open(onClose = vi.fn()) {
  act(() => {
    root.render(<RedactionPropertiesDialog isOpen onClose={onClose} />);
  });
  return onClose;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(found).not.toBeNull();
  return found as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
  expect(found).toBeDefined();
  return found as HTMLButtonElement;
}

function overlayInput(): HTMLInputElement {
  const input = dialog().querySelector<HTMLInputElement>('.mark-style-overlay');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

function colourInputs(): HTMLInputElement[] {
  return [...dialog().querySelectorAll<HTMLInputElement>('input[type="color"]')];
}

// Sets an input's value the way the browser does, through the native setter, so React sees a change.
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// The overlay text is committed on blur, as in a browser: focus it, then move focus away.
function commitOverlay(input: HTMLInputElement) {
  act(() => {
    input.focus();
    input.blur();
  });
}

function stored(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('RedactionPropertiesDialog', () => {
  it('shows the stored style of new marks', () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        redactionFill: '#ff0000',
        redactionTextColor: '#00ff00',
        redactionOverlayText: 'EXEMPT',
      }),
    );
    open();
    expect(dialog().textContent).toContain(t('redactions.properties'));
    expect(colourInputs()[0]?.value).toBe('#ff0000');
    expect(colourInputs()[1]?.value).toBe('#00ff00');
    expect(overlayInput().value).toBe('EXEMPT');
  });

  it('caps the overlay text at the preferences limit of 64', () => {
    open();
    expect(overlayInput().maxLength).toBe(64);
  });

  it('stores at most 64 characters of overlay text typed before Apply', () => {
    const onClose = open();
    const input = overlayInput();
    act(() => {
      input.focus();
    });
    type(input, 'x'.repeat(100));
    // A mouse press moves focus to Apply before the click, which blurs and commits the text. jsdom's
    // click() and focus() do not blur the field, so the press is modelled by blurring it first.
    commitOverlay(input);
    act(() => {
      button(t('prefs.apply')).click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(stored().redactionOverlayText).toHaveLength(64);
  });

  it('Apply writes the three style keys and keeps the other preferences', () => {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ authorName: 'Ann' }));
    const onClose = open();
    type(colourInputs()[0] as HTMLInputElement, '#112233');
    type(overlayInput(), 'REDACTED');
    commitOverlay(overlayInput());
    act(() => {
      button(t('prefs.apply')).click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    const prefs = readPreferences();
    expect(prefs.redactionFill).toBe('#112233');
    expect(prefs.redactionTextColor).toBe('#ffffff');
    expect(prefs.redactionOverlayText).toBe('REDACTED');
    expect(prefs.authorName).toBe('Ann');
    expect(stored()).toMatchObject({ authorName: 'Ann', redactionOverlayText: 'REDACTED' });
  });

  it('Cancel closes and writes nothing', () => {
    const onClose = open();
    type(overlayInput(), 'DISCARD');
    commitOverlay(overlayInput());
    act(() => {
      button(t('prefs.cancel')).click();
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull();
  });

  it('stays open and keeps the stored values when the browser refuses to store', () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ redactionOverlayText: 'KEEP' }),
    );
    const before = window.localStorage.getItem(PREFS_STORAGE_KEY);
    const onClose = open();
    type(overlayInput(), 'CHANGED');
    commitOverlay(overlayInput());
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    act(() => {
      button(t('prefs.apply')).click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PREFS_STORAGE_KEY)).toBe(before);
    expect(readPreferences().redactionOverlayText).toBe('KEEP');
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe(
      t('prefs.redaction.saveFailed'),
    );
  });
});
