import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { JobProgressHost } from './JobProgressHost';
import { type AbortClient, createJobProgressStore } from './jobRun';
import { createToastStore, type ToastStore } from './toasts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeClient(abort = vi.fn(async () => ({}))): AbortClient & { call: typeof abort } {
  return { call: abort } as unknown as AbortClient & { call: typeof abort };
}

function toastTexts(store: ToastStore): string[] {
  return store.getState().visible.map((toast) => toast.text);
}

describe('the job store', () => {
  it('refuses a second job while one runs', () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    const job = { handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() };
    expect(store.begin(job)).toBe(true);
    expect(store.begin({ ...job, token: 'j2' })).toBe(false);
    expect(store.getState().job?.token).toBe('j1');
  });

  it('a success hides the bar and shows a success toast', () => {
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    store.begin({ handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() });

    store.finish('j1', { ok: true });

    expect(store.getState().job).toBeUndefined();
    expect(toasts.getState().visible[0]).toMatchObject({
      kind: 'success',
      text: t('job.done', { label: 'Reduce size' }),
    });
  });

  it('an error shows the mapped error toast; a cancel shows nothing', () => {
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    store.begin({ handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() });
    store.finish('j1', { ok: false, error: new RpcError('SAVE_FAILED', 'x') });
    expect(toastTexts(toasts)).toEqual([t('error.SAVE_FAILED')]);

    store.begin({ handle: 'h', token: 'j2', label: 'Reduce size', client: fakeClient() });
    store.finish('j2', { ok: false, error: new RpcError('CANCELLED', 'x') });
    expect(toastTexts(toasts)).toEqual([t('error.SAVE_FAILED')]);
  });

  it('ignores progress and finish for another token', () => {
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    store.begin({ handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() });
    store.progress('other', 50);
    store.finish('other', { ok: true });
    expect(store.getState().job?.percent).toBeUndefined();
    expect(toasts.getState().visible).toHaveLength(0);
  });
});

describe('JobProgressHost', () => {
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

  function cancelButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('.job-cancel');
  }

  it('stays hidden while no job runs', () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    act(() => root.render(<JobProgressHost store={store} />));
    expect(container.innerHTML).toBe('');
  });

  it('renders the label and moves with the progress', () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    act(() => root.render(<JobProgressHost store={store} />));
    act(() => {
      store.begin({ handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() });
    });
    expect(container.textContent).toContain('Reduce size');
    expect(container.textContent).toContain(t('job.working'));

    act(() => store.progress('j1', 40));

    expect(container.textContent).toContain(t('job.percent', { percent: 40 }));
    expect(container.querySelector('progress')?.getAttribute('value')).toBe('40');
  });

  it('Cancel calls jobs.abort with the handle and token, then hides the bar', async () => {
    const abort = vi.fn(async () => ({}));
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    act(() => root.render(<JobProgressHost store={store} />));
    act(() => {
      store.begin({
        handle: 'doc-1',
        token: 'j1',
        label: 'Reduce size',
        client: fakeClient(abort),
      });
    });

    await act(async () => cancelButton()?.click());

    expect(abort).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(store.getState().job).toBeUndefined();
    expect(toasts.getState().visible).toHaveLength(0);
  });

  it('a failed abort keeps the bar and shows an error toast', async () => {
    const abort = vi.fn(async () => {
      throw new RpcError('BUSY', 'busy');
    });
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    act(() => root.render(<JobProgressHost store={store} />));
    act(() => {
      store.begin({
        handle: 'doc-1',
        token: 'j1',
        label: 'Reduce size',
        client: fakeClient(abort),
      });
    });

    await act(async () => cancelButton()?.click());

    expect(store.getState().job?.token).toBe('j1');
    expect(toastTexts(toasts)).toEqual([t('error.BUSY')]);
  });

  it('a finished job hides the bar', () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    act(() => root.render(<JobProgressHost store={store} />));
    act(() => {
      store.begin({ handle: 'h', token: 'j1', label: 'Reduce size', client: fakeClient() });
    });
    act(() => store.finish('j1', { ok: true }));
    expect(container.innerHTML).toBe('');
  });
});
