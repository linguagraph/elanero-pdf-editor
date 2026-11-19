import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineClient } from '../engine/engineConnection';
import type { RestartOptions, RestartResult } from '../engine/restart';
import { t } from '../i18n/t';
import { RpcError, RpcTimeoutError } from '../rpc/client';
import { NotRespondingHost } from './NotRespondingHost';
import { createNotRespondingStore, type EngineSession } from './notResponding';
import { lostItemsText } from './lostWork';
import { createToastStore, type ToastStore } from './toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no CSS.escape, and react-aria calls it when a modal opens.
if (typeof (globalThis as { CSS?: { escape?: unknown } }).CSS?.escape !== 'function') {
  Object.defineProperty(globalThis, 'CSS', {
    configurable: true,
    value: { escape: (value: string) => value.replace(/[^\w-]/g, (c) => `\\${c}`) },
  });
}

const timeout = () => new RpcTimeoutError('document.render', 15000);
const outOfMemory = () => new RpcError('OUT_OF_MEMORY', 'the engine ran out of memory', {});
const DOCS = [
  { id: 'a', name: 'Report.pdf' },
  { id: 'b', name: 'Invoice.pdf' },
];
const CLIENT = { call: vi.fn() } as unknown as EngineClient;

// A session whose engine restarts, and whose documents have the given autosave copies.
function session(
  bytes: Record<string, ArrayBuffer>,
  options: { reopen?: EngineSession['reopen']; protectedIds?: string[] } = {},
): EngineSession {
  return {
    engine: {
      restart: vi.fn(() => true),
      whenReady: vi.fn(() => Promise.resolve(CLIENT)),
    },
    documents: DOCS,
    bytesOf: (id) => Promise.resolve(bytes[id]),
    isProtected: (id) => options.protectedIds?.includes(id) ?? false,
    reopen: options.reopen ?? vi.fn(() => Promise.resolve()),
  };
}

function restartOk(): RestartResult {
  return { ok: true, reopen: DOCS, lost: { items: [], text: '' } };
}

function toastTexts(store: ToastStore): string[] {
  return store.getState().visible.map((toast) => toast.text);
}

describe('the not-responding state', () => {
  it('opens once for a deadline error and ignores other errors', () => {
    const store = createNotRespondingStore({ toasts: createToastStore() });
    expect(store.report(new RpcError('INTERNAL', 'boom'))).toBe(false);
    expect(store.getState().error).toBeUndefined();

    expect(store.report(timeout())).toBe(true);
    expect(store.report(timeout())).toBe(false);
    expect(store.getState().error).toBeInstanceOf(RpcTimeoutError);
    expect(store.getState().reason).toBe('timeout');
  });

  it('opens for an out-of-memory error, with the memory reason', () => {
    const store = createNotRespondingStore({ toasts: createToastStore() });

    expect(store.report(outOfMemory())).toBe(true);
    expect(store.getState().reason).toBe('memory');
  });

  it('Wait closes the dialog and does not restart the engine', () => {
    const restart = vi.fn();
    const store = createNotRespondingStore({ restart, toasts: createToastStore() });
    store.setSession(session({}));
    store.report(timeout());

    store.wait();

    expect(store.getState().error).toBeUndefined();
    expect(restart).not.toHaveBeenCalled();
  });

  it('Restart replaces the engine, reopens the copies and names the documents with none', async () => {
    const toasts = createToastStore();
    const restart = vi.fn<(options: RestartOptions) => RestartResult>(() => restartOk());
    const reopen = vi.fn<EngineSession['reopen']>(() => Promise.resolve());
    const current = session({ a: new ArrayBuffer(4) }, { reopen });
    const store = createNotRespondingStore({ restart, toasts });
    store.setSession(current);
    store.report(timeout());

    await store.restart();

    expect(restart).toHaveBeenCalledTimes(1);
    // The restart helper replaces the engine through the session's connection.
    restart.mock.calls[0]?.[0]?.replaceEngine();
    expect(current.engine.restart).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toBeUndefined();
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen).toHaveBeenCalledWith(DOCS[0], expect.any(ArrayBuffer), CLIENT);
    const texts = toastTexts(toasts);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Invoice.pdf');
    expect(texts[0]).toContain(t('engine.lost.autosave'));
    expect(texts[0]).toContain(t('engine.lost.undo'));
  });

  it('a restart with every document reopened still names the lost work', async () => {
    const toasts = createToastStore();
    const reopen = vi.fn<EngineSession['reopen']>(() => Promise.resolve());
    const store = createNotRespondingStore({ restart: () => restartOk(), toasts });
    store.setSession(session({ a: new ArrayBuffer(1), b: new ArrayBuffer(1) }, { reopen }));

    await store.restart();

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(toastTexts(toasts)).toEqual([t('engine.restart.done', { items: lostItemsText() })]);
  });

  it('a document whose copy fails to reopen is named as lost', async () => {
    const toasts = createToastStore();
    const reopen = vi.fn<EngineSession['reopen']>(() => Promise.reject(new Error('open failed')));
    const store = createNotRespondingStore({ restart: () => restartOk(), toasts });
    store.setSession(session({ a: new ArrayBuffer(1), b: new ArrayBuffer(1) }, { reopen }));

    await store.restart();

    expect(toastTexts(toasts)[0]).toContain('Report.pdf, Invoice.pdf');
  });

  it('a password-protected document is named with its own message', async () => {
    const toasts = createToastStore();
    const store = createNotRespondingStore({ restart: () => restartOk(), toasts });
    store.setSession(session({ a: new ArrayBuffer(1) }, { protectedIds: ['b'] }));

    await store.restart();

    // Report.pdf came back from its copy; Invoice.pdf is named with the protected message only.
    expect(toastTexts(toasts)).toEqual([
      t('engine.restart.lost.protected', { names: 'Invoice.pdf' }),
    ]);
  });

  it('a failed restart keeps the old session and says so', async () => {
    const toasts = createToastStore();
    const store = createNotRespondingStore({
      restart: () => ({ ok: false, code: 'ENGINE_START_FAILED' }),
      toasts,
    });
    store.setSession(session({}));

    await store.restart();

    expect(toastTexts(toasts)).toEqual([t('engine.restart.failed')]);
  });

  it('Restart with no engine session says there is nothing to restart', async () => {
    const toasts = createToastStore();
    const restart = vi.fn();
    const store = createNotRespondingStore({ restart, toasts });

    await store.restart();

    expect(restart).not.toHaveBeenCalled();
    expect(toastTexts(toasts)).toEqual([t('engine.restart.unavailable')]);
  });
});

describe('NotRespondingHost', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function dialogButton(label: string): HTMLButtonElement | undefined {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === label,
    );
  }

  it('opens one dialog on a timeout and closes it on Wait', () => {
    const store = createNotRespondingStore({ toasts: createToastStore() });
    act(() => root.render(<NotRespondingHost store={store} />));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    act(() => {
      store.report(timeout());
      store.report(timeout());
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    act(() => dialogButton(t('engine.notResponding.wait'))?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('an out-of-memory error opens the memory variant of the dialog', () => {
    const store = createNotRespondingStore({ toasts: createToastStore() });
    act(() => root.render(<NotRespondingHost store={store} />));

    act(() => {
      store.report(outOfMemory());
    });

    const title = document.querySelector('[role="dialog"] h2');
    expect(title?.textContent).toBe(t('engine.outOfMemory.title'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      t('engine.outOfMemory.body'),
    );
  });

  it('Restart engine in the dialog runs the store restart', () => {
    const restart = vi.fn(() => restartOk());
    const store = createNotRespondingStore({ restart, toasts: createToastStore() });
    store.setSession(session({}));
    act(() => root.render(<NotRespondingHost store={store} />));
    act(() => {
      store.report(timeout());
    });

    act(() => dialogButton(t('engine.restart.confirm'))?.click());

    expect(restart).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
