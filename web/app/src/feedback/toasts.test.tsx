import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError, RpcTimeoutError } from '../rpc/client';
import { ToastRegion } from './ToastRegion';
import {
  AUTO_DISMISS_MS,
  createToastStore,
  enqueueToast,
  removeToast,
  reportRpcError,
  VISIBLE_TOASTS,
  type Toast,
  type ToastQueue,
  type ToastStore,
} from './toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY: ToastQueue = { visible: [], queued: [] };

function toast(id: number, kind: Toast['kind'] = 'info'): Toast {
  return { id, kind, text: `message ${id}` };
}

describe('toast queue', () => {
  it('shows up to the limit and queues the rest in order', () => {
    let queue = EMPTY;
    for (let id = 1; id <= VISIBLE_TOASTS + 2; id++) queue = enqueueToast(queue, toast(id));
    expect(queue.visible.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(queue.queued.map((item) => item.id)).toEqual([4, 5]);
  });

  it('moves the oldest queued toast up when a visible one leaves', () => {
    let queue = EMPTY;
    for (let id = 1; id <= 4; id++) queue = enqueueToast(queue, toast(id));
    queue = removeToast(queue, 2);
    expect(queue.visible.map((item) => item.id)).toEqual([1, 3, 4]);
    expect(queue.queued).toEqual([]);
  });

  it('removes a queued toast without touching the visible ones', () => {
    let queue = EMPTY;
    for (let id = 1; id <= 4; id++) queue = enqueueToast(queue, toast(id));
    queue = removeToast(queue, 4);
    expect(queue.visible.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(queue.queued).toEqual([]);
  });
});

describe('toast store', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const store = createToastStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.push('info', 'saved');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.push('info', 'again');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout as a persistent error through the catalogue', () => {
    const store = createToastStore();
    reportRpcError(store, new RpcTimeoutError('render', 5000));
    const [shown] = store.getState().visible;
    expect(shown?.kind).toBe('error');
    expect(shown?.text).toBe(
      'Elanero is still working on this. You can wait, or restart the engine.',
    );
  });

  it('shows nothing for a cancelled call', () => {
    const store = createToastStore();
    expect(reportRpcError(store, new RpcError('CANCELLED', 'cancelled'))).toBeUndefined();
    expect(store.getState().visible).toEqual([]);
  });
});

describe('ToastRegion', () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: ToastStore;

  const render = () => {
    act(() => {
      root.render(<ToastRegion store={store} />);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = createToastStore();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.useRealTimers();
  });

  it('labels the region and gives errors the alert role and others the status role', () => {
    act(() => {
      store.push('info', 'Opened');
      store.push('error', 'Failed');
    });
    render();
    expect(host.querySelector('section')?.getAttribute('aria-label')).toBe('Notifications');
    expect(host.querySelector('[data-kind="info"]')?.getAttribute('role')).toBe('status');
    expect(host.querySelector('[data-kind="error"]')?.getAttribute('role')).toBe('alert');
  });

  it('auto-dismisses info and success toasts, and keeps errors', () => {
    act(() => {
      store.push('info', 'Info');
      store.push('success', 'Done');
      store.push('error', 'Broken');
    });
    render();
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS - 1);
    });
    expect(host.textContent).toContain('Info');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(host.textContent).not.toContain('Info');
    expect(host.textContent).not.toContain('Done');
    expect(host.textContent).toContain('Broken');
    act(() => {
      vi.advanceTimersByTime(10 * AUTO_DISMISS_MS);
    });
    expect(host.textContent).toContain('Broken');
  });

  it('pauses the timer while keyboard focus is inside the region', () => {
    act(() => {
      store.push('info', 'Waiting');
    });
    render();
    const dismiss = host.querySelector<HTMLButtonElement>('.toast-dismiss');
    act(() => {
      dismiss?.focus();
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS * 3);
    });
    expect(host.textContent).toContain('Waiting');
    act(() => {
      dismiss?.blur();
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS);
    });
    expect(host.textContent).not.toContain('Waiting');
  });

  it('removes a toast when its dismiss button is pressed', () => {
    act(() => {
      store.push('error', 'Broken');
    });
    render();
    const dismiss = host.querySelector<HTMLButtonElement>('.toast-dismiss');
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss: Broken');
    act(() => {
      dismiss?.click();
    });
    expect(host.querySelector('.toast')).toBeNull();
  });
});
