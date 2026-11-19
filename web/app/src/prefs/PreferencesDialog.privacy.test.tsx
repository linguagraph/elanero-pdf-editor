import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import type { ClearOutcome } from '../storage/clearLocalData';
import { PreferencesDialog } from './PreferencesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// The Privacy section of the Preferences dialog, rendered on its own so the document-open rule
// and the clear flow can be driven directly (the App-level tests cover the rest of the dialog).
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
});

interface Harness {
  clearData: ReturnType<typeof vi.fn<() => Promise<ClearOutcome>>>;
  reloadPage: ReturnType<typeof vi.fn<() => void>>;
}

function render(hasDocuments: boolean, outcome: ClearOutcome): Harness {
  const harness: Harness = {
    clearData: vi.fn(() => Promise.resolve(outcome)),
    reloadPage: vi.fn(),
  };
  act(() => {
    root.render(
      <PreferencesDialog
        isOpen
        onClose={() => undefined}
        hasDocuments={hasDocuments}
        clearData={harness.clearData}
        reloadPage={harness.reloadPage}
      />,
    );
  });
  return harness;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error('dialog not open');
  return found;
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function clickButton(label: string): void {
  act(() => {
    buttonNamed(label).click();
  });
}

// Resolves the pending clear, then lets React apply its state.
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const COMPLETE: ClearOutcome = { keysRemoved: 3, complete: true };

describe('PreferencesDialog: Clear all local data', () => {
  it('is disabled, with the reason shown, while a document is open', () => {
    render(true, COMPLETE);
    expect(buttonNamed(t('prefs.clearAll.open')).disabled).toBe(true);
    expect(dialog().textContent).toContain(t('prefs.clearAll.blocked'));
  });

  it('is enabled, with no reason shown, when no document is open', () => {
    render(false, COMPLETE);
    expect(buttonNamed(t('prefs.clearAll.open')).disabled).toBe(false);
    expect(dialog().textContent).not.toContain(t('prefs.clearAll.blocked'));
  });

  it('asks for confirmation first, and Keep clears nothing', () => {
    const harness = render(false, COMPLETE);
    clickButton(t('prefs.clearAll.open'));
    expect(dialog().textContent).toContain(t('prefs.clearAll.confirm'));
    clickButton(t('prefs.clearAll.keep'));
    expect(dialog().textContent).not.toContain(t('prefs.clearAll.confirm'));
    expect(harness.clearData).not.toHaveBeenCalled();
    expect(harness.reloadPage).not.toHaveBeenCalled();
  });

  it('moves focus to Keep when the confirmation opens', () => {
    render(false, COMPLETE);
    clickButton(t('prefs.clearAll.open'));
    expect(document.activeElement).toBe(buttonNamed(t('prefs.clearAll.keep')));
  });

  it('clears, then reloads the page once everything was removed', async () => {
    const harness = render(false, COMPLETE);
    clickButton(t('prefs.clearAll.open'));
    clickButton(t('prefs.clearAll.clear'));
    await settle();
    expect(harness.clearData).toHaveBeenCalledTimes(1);
    expect(harness.reloadPage).toHaveBeenCalledTimes(1);
  });

  it('shows the message and does not reload when the clear is incomplete', async () => {
    const harness = render(false, { keysRemoved: 1, complete: false });
    clickButton(t('prefs.clearAll.open'));
    clickButton(t('prefs.clearAll.clear'));
    await settle();
    expect(harness.reloadPage).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain(t('prefs.clearAll.incomplete'));
    expect(buttonNamed(t('prefs.clearAll.open')).disabled).toBe(false);
  });
});
