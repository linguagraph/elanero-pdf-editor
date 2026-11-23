import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationInfoResult } from '../rpc/generated';
import { NOTICE_VERSION } from '../translate/consent';
import { t } from '../i18n/t';
import { PREFS_STORAGE_KEY } from './store';
import { PreferencesDialog } from './PreferencesDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// The Translation section of the Preferences dialog (W6.6 slice S2): the switch, the consent notice
// and the default language. The engine is replaced by a fake that answers translation.info.
let host: HTMLDivElement;
let root: Root;

const INFO: TranslationInfoResult = {
  services: [
    {
      id: 'mymemory',
      name: 'MyMemory',
      privacy_url: 'https://translated.com/confidentiality',
      detects_source: false,
      max_chars: 2000,
    },
  ],
  languages: {
    mymemory: [
      { code: 'fr', name: 'French' },
      { code: 'de', name: 'German' },
    ],
  },
};

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

function render(loadTranslationInfo?: () => Promise<TranslationInfoResult>): void {
  act(() => {
    root.render(
      <PreferencesDialog
        isOpen
        onClose={() => undefined}
        hasDocuments={false}
        clearData={() => Promise.resolve({ keysRemoved: 0, complete: true })}
        reloadPage={() => undefined}
        loadTranslationInfo={loadTranslationInfo}
      />,
    );
  });
}

function prefsDialog(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) =>
    element.textContent?.includes(t('prefs.title')),
  );
  if (found === undefined) throw new Error('preferences not open');
  return found;
}

function noticeDialog(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) =>
    element.textContent?.includes(t('translate.notice.title')),
  );
}

function labelled(text: string): HTMLLabelElement {
  const found = [...prefsDialog().querySelectorAll('label')].find((label) =>
    label.textContent?.includes(text),
  );
  if (found === undefined) throw new Error(`no label ${text}`);
  return found;
}

// The switch's own input: react-aria's label does not toggle on a plain label click in jsdom.
function switchInput(): HTMLInputElement {
  const input = labelled(t('prefs.translation.enable')).querySelector('input');
  if (input === null) throw new Error('no switch input');
  return input;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

function press(element: HTMLElement): void {
  act(() => {
    element.click();
  });
}

function storedPrefs(): Record<string, unknown> {
  return JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}') as Record<
    string,
    unknown
  >;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('PreferencesDialog: Translation section', () => {
  it('has the switch, the default language and the desktop sentence, and no key, email or service field', () => {
    render();
    const section = prefsDialog().textContent ?? '';
    expect(section).toContain(t('prefs.translation.enable'));
    expect(section).toContain(t('prefs.translation.note'));
    expect(section).toContain('Elanero for Windows');
    const texts = [...prefsDialog().querySelectorAll('label')].map((l) => l.textContent ?? '');
    expect(texts.join('\n')).not.toMatch(/key|e-?mail|region|connection|service/i);
    expect(prefsDialog().querySelectorAll('input[type="password"]')).toHaveLength(0);
  });

  it('opens the consent notice before anything is turned on, and Cancel records nothing', () => {
    render();
    press(switchInput());
    expect(noticeDialog()).toBeDefined();
    press(buttonIn(noticeDialog() as HTMLElement, t('translate.notice.cancel')));
    expect(noticeDialog()).toBeUndefined();
    expect(storedPrefs().translationConsent).toBeUndefined();
    expect(storedPrefs().translationEnabled).toBeUndefined();
  });

  it('agreeing records the consent at once, with the notice version', () => {
    render();
    press(switchInput());
    press(buttonIn(noticeDialog() as HTMLElement, t('translate.notice.agree')));
    expect(storedPrefs().translationEnabled).toBe(true);
    expect(storedPrefs().translationConsent).toMatchObject({
      service: 'mymemory',
      version: NOTICE_VERSION,
    });
    expect(noticeDialog()).toBeUndefined();
  });

  it('turning it off and applying clears the record, so the notice asks again', () => {
    render();
    press(switchInput());
    press(buttonIn(noticeDialog() as HTMLElement, t('translate.notice.agree')));
    press(switchInput());
    act(() => {
      prefsDialog().querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    expect(storedPrefs().translationEnabled).toBe(false);
    expect(storedPrefs().translationConsent).toBeNull();
  });

  it('lists the languages from translation.info, and offers the privacy policy links', async () => {
    const load = vi.fn(() => Promise.resolve(INFO));
    render(load);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    const options = [...labelled(t('prefs.translation.language')).querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(options).toEqual(['', 'fr', 'de']);
    const links = [...prefsDialog().querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('https://translated.com/confidentiality');
    expect(links.some((href) => href?.endsWith('/PRIVACY.md'))).toBe(true);
  });

  it('still works when the languages cannot be read: the app language only', async () => {
    render(() => Promise.reject(new Error('engine not ready')));
    await settle();
    const options = [...labelled(t('prefs.translation.language')).querySelectorAll('option')].map(
      (o) => o.value,
    );
    expect(options).toEqual(['']);
  });
});
