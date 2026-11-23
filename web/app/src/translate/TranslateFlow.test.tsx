import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageRpc } from '../engine/engineConnection';
import { PREFS_STORAGE_KEY } from '../prefs/store';
import type { TranslationInfoResult } from '../rpc/generated';
import type { DocumentViewHandle } from '../view/DocumentView';
import type { PageArea } from '../text/textLayer';
import { NOTICE_VERSION } from './consent';
import { TranslateFlow, type TranslateFlowHandle } from './TranslateFlow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

// The translate flow (W6.6 sections 7 and 8): no request before the user agrees to the notice, and
// the bubble's translation through the engine's translation.translate call.

const AREA: PageArea = {
  page: 0,
  rect: { x0: 10, y0: 20, x1: 110, y1: 40 },
  quads: [
    {
      ul: { x: 10, y: 20 },
      ur: { x: 110, y: 20 },
      ll: { x: 10, y: 40 },
      lr: { x: 110, y: 40 },
    },
  ],
  text: 'Hello world',
};

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
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' },
    ],
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function setup(
  translate = vi.fn().mockResolvedValue({ text: 'Bonjour', detected: null, service: 'mymemory' }),
) {
  const ref = createRef<TranslateFlowHandle>();
  const view = {
    selectedAreas: () => ({ state: 'ready', value: [AREA] }),
    cachedLines: () => undefined,
  } as unknown as DocumentViewHandle;
  const rpc = { call: vi.fn().mockResolvedValue({ executed: false, state: { history: {} } }) };
  const loadInfo = vi.fn().mockResolvedValue(INFO);
  act(() => {
    root.render(
      <TranslateFlow
        ref={ref}
        getView={() => view}
        loadInfo={loadInfo}
        translate={translate}
        rpc={rpc as unknown as PageRpc}
        handle="h1"
        scheduler={{ noteRevisions: vi.fn() }}
      />,
    );
  });
  return { ref, translate, loadInfo, rpc };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

// jsdom has no Range.getClientRects; the anchor reads the last line of the browser's selection.
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
}

describe('TranslateFlow consent', () => {
  it('opens the notice, and sends nothing, before the user agrees', async () => {
    const { ref, translate } = setup();
    act(() => ref.current?.translate());
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(translate).not.toHaveBeenCalled();
  });

  it('Cancel sends nothing and records nothing', async () => {
    const { ref, translate } = setup();
    act(() => ref.current?.translate());
    await flush();
    act(() => buttonNamed('Cancel').click());
    await flush();
    expect(translate).not.toHaveBeenCalled();
    const stored = JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}');
    expect(stored.translationConsent ?? null).toBeNull();
    expect(stored.translationEnabled ?? false).toBe(false);
  });

  it('Turn on records the current notice, then translates the selection', async () => {
    const { ref, translate } = setup();
    act(() => ref.current?.translate());
    await flush();
    act(() => buttonNamed('Turn on').click());
    await flush();
    const stored = JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}');
    expect(stored.translationEnabled).toBe(true);
    expect(stored.translationConsent).toMatchObject({
      service: 'mymemory',
      version: NOTICE_VERSION,
    });
    expect(translate).toHaveBeenCalledWith({ text: 'Hello world', source: 'en', target: 'fr' });
    expect(document.querySelector('.translate-bubble__text')?.textContent).toBe('Bonjour');
  });

  it('asks again when the record is for an older notice', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        translationEnabled: true,
        translationConsent: {
          service: 'mymemory',
          version: NOTICE_VERSION - 1,
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const { ref, translate } = setup();
    act(() => ref.current?.translate());
    await flush();
    expect(translate).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('translates straight away once the current notice is agreed to', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        translationEnabled: true,
        translationConsent: {
          service: 'mymemory',
          version: NOTICE_VERSION,
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const { ref, translate } = setup();
    act(() => ref.current?.translate());
    await flush();
    expect(translate).toHaveBeenCalledTimes(1);
  });
});

describe('TranslateBubble contents', () => {
  it('offers only the listed languages, with no detect entry', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        translationEnabled: true,
        translationConsent: {
          service: 'mymemory',
          version: NOTICE_VERSION,
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const { ref } = setup();
    act(() => ref.current?.translate());
    await flush();
    const values = [...document.querySelectorAll('select option')].map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).not.toContain('');
    expect(values).toEqual(['en', 'fr', 'en', 'fr']);
  });

  it('Add as note calls the highlight action with the translation', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        translationEnabled: true,
        translationConsent: {
          service: 'mymemory',
          version: NOTICE_VERSION,
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const { ref, rpc } = setup();
    act(() => ref.current?.translate());
    await flush();
    await act(async () => buttonNamed('Add as note').click());
    await flush();
    expect(rpc.call).toHaveBeenCalledWith(
      'actions.run',
      expect.objectContaining({ name: 'annotations.highlight_text' }),
    );
  });

  it('Escape closes the bubble when focus is on the page, not the bubble', async () => {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        translationEnabled: true,
        translationConsent: {
          service: 'mymemory',
          version: NOTICE_VERSION,
          at: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const { ref } = setup();
    act(() => ref.current?.translate());
    await flush();
    expect(document.querySelector('.translate-bubble')).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flush();
    expect(document.querySelector('.translate-bubble')).toBeNull();
  });
});
