import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestartResult } from '../engine/restart';
import type { WorkerClient } from '../engine/start';
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

function fakeWorker(): WorkerClient & { terminate: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(),
    onStage: vi.fn(() => () => undefined),
    terminate: vi.fn(),
  } as unknown as WorkerClient & { terminate: ReturnType<typeof vi.fn> };
}

function session(bytes: Record<string, ArrayBuffer>, reopen = vi.fn()): EngineSession {
  return {
    worker: fakeWorker(),
    start: { workerUrl: 'http://localhost/w.js', assetBaseUrl: 'http://localhost/engine/' },
    documents: [
      { id: 'a', name: 'Report.pdf' },
      { id: 'b', name: 'Invoice.pdf' },
    ],
    bytesOf: (id) => bytes[id],
    reopen,
  };
}

function okRestart(): RestartResult {
  return {
    ok: true,
    worker: fakeWorker(),
    reopen: [
      { id: 'a', name: 'Report.pdf' },
      { id: 'b', name: 'Invoice.pdf' },
    ],
    lost: { items: [], text: '' },
  };
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

  it('Restart calls restartEngine and shows the lost-work text when bytes are missing', () => {
    const toasts = createToastStore();
    const restart = vi.fn(() => okRestart());
    const reopen = vi.fn();
    const store = createNotRespondingStore({ restart, toasts });
    store.setSession(session({ a: new ArrayBuffer(4) }, reopen));
    store.report(timeout());

    store.restart();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toBeUndefined();
    // Report.pdf had bytes and is reopened; Invoice.pdf has none and is named as lost.
    expect(reopen).toHaveBeenCalledWith(
      { id: 'a', name: 'Report.pdf' },
      expect.any(ArrayBuffer),
      expect.anything(),
    );
    const texts = toastTexts(toasts);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('Invoice.pdf');
    expect(texts[0]).toContain(t('engine.lost.autosave'));
    expect(texts[0]).toContain(t('engine.lost.undo'));
  });

  it('a restart with every document reopened still names the lost work', () => {
    const toasts = createToastStore();
    const reopen = vi.fn();
    const store = createNotRespondingStore({ restart: () => okRestart(), toasts });
    store.setSession(session({ a: new ArrayBuffer(1), b: new ArrayBuffer(1) }, reopen));

    store.restart();

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(toastTexts(toasts)).toEqual([t('engine.restart.done', { items: lostItemsText() })]);
  });

  it('a failed restart keeps the old session and says so', () => {
    const toasts = createToastStore();
    const store = createNotRespondingStore({
      restart: () => ({ ok: false, code: 'ENGINE_START_FAILED', message: 'x' }),
      toasts,
    });
    store.setSession(session({}));

    store.restart();

    expect(toastTexts(toasts)).toEqual([t('engine.restart.failed')]);
  });

  it('Restart with no engine session says there is nothing to restart', () => {
    const toasts = createToastStore();
    const restart = vi.fn();
    const store = createNotRespondingStore({ restart, toasts });

    store.restart();

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

  it('Restart engine in the dialog runs the store restart', () => {
    const restart = vi.fn(() => okRestart());
    const store = createNotRespondingStore({ restart, toasts: createToastStore() });
    store.setSession(session({}));
    act(() => root.render(<NotRespondingHost store={store} />));
    act(() => store.report(timeout()));

    act(() => dialogButton(t('engine.restart.confirm'))?.click());

    expect(restart).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
