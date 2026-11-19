import { describe, expect, it, vi } from 'vitest';
import { createJobProgressStore } from './jobRun';
import { createToastStore } from './toasts';

describe('job progress store cancel', () => {
  it('calls jobs.abort with the handle and token, then hides the bar', async () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    const call = vi.fn(() => Promise.resolve({}));
    store.begin({ handle: 'h1', token: 'job-1', label: 'Compressing', client: { call } });

    await store.cancel();

    expect(call).toHaveBeenCalledWith('jobs.abort', { handle: 'h1', token: 'job-1' });
    expect(store.getState().job).toBeUndefined();
  });

  it('keeps the bar and shows an error when jobs.abort fails', async () => {
    const toasts = createToastStore();
    const store = createJobProgressStore({ toasts });
    const call = vi.fn(() => Promise.reject(new Error('the engine is busy')));
    store.begin({ handle: 'h1', token: 'job-1', label: 'Compressing', client: { call } });

    await store.cancel();

    expect(store.getState().job?.token).toBe('job-1');
    expect(toasts.getState().visible).toHaveLength(1);
  });

  it('terminates a job that has no abort, and hides the bar', async () => {
    const store = createJobProgressStore({ toasts: createToastStore() });
    const terminate = vi.fn();
    store.begin({ token: 'merge-1', label: 'Combining files', terminate });

    await store.cancel();

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(store.getState().job).toBeUndefined();
  });
});
