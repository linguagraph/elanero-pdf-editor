import { describe, expect, it, vi } from 'vitest';
import { createToastStore } from '../feedback/toasts';
import { RpcError } from '../rpc/client';
import { reportSaveOutcome } from './saveReport';
import type { SaveOutcome } from './saver';

const BYTES = new ArrayBuffer(4);

function saved(extra: Partial<Extract<SaveOutcome, { status: 'saved' }>> = {}): SaveOutcome {
  return {
    status: 'saved',
    name: 'report.pdf',
    incremental: false,
    data: BYTES,
    changedSince: false,
    ...extra,
  };
}

describe('reportSaveOutcome', () => {
  it('says the file was downloaded, with a Download again action that downloads the same bytes', () => {
    const store = createToastStore();
    const download = vi.fn();
    reportSaveOutcome(saved(), download, store);

    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('success');
    expect(toast?.text).toContain('report.pdf');
    toast?.action?.run();
    expect(download).toHaveBeenCalledWith('report.pdf', BYTES);
  });

  it('asks the user to replace the original with an incremental (signed) download', () => {
    const store = createToastStore();
    reportSaveOutcome(saved({ incremental: true }), vi.fn(), store);
    expect(store.getState().visible[0]?.text).toMatch(/signatures valid/);
  });

  it('adds an info toast when the document changed while it was saved', () => {
    const store = createToastStore();
    reportSaveOutcome(saved({ changedSince: true }), vi.fn(), store);
    expect(store.getState().visible.map((toast) => toast.kind)).toEqual(['success', 'info']);
  });

  it('shows the signed-refusal wording for a refused in-place save of a signed document', () => {
    const store = createToastStore();
    reportSaveOutcome(
      {
        status: 'failed',
        error: new RpcError('SAVE_FAILED', 'refused'),
        context: { signedInPlaceSave: true },
      },
      vi.fn(),
      store,
    );
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('error');
    expect(toast?.text).toMatch(/Save it as a new file/);
  });

  it('shows the busy wording for a save during a task', () => {
    const store = createToastStore();
    reportSaveOutcome(
      { status: 'failed', error: new RpcError('BUSY', 'busy'), context: {} },
      vi.fn(),
      store,
    );
    expect(store.getState().visible[0]?.text).toMatch(/Wait for the current task/);
  });

  it('offers Download when the browser blocked the download', () => {
    const store = createToastStore();
    const download = vi.fn();
    reportSaveOutcome({ status: 'download-blocked', name: 'a.pdf', data: BYTES }, download, store);
    const [toast] = store.getState().visible;
    expect(toast?.kind).toBe('warning');
    toast?.action?.run();
    expect(download).toHaveBeenCalledWith('a.pdf', BYTES);
  });

  it('says nothing for a save that was already running', () => {
    const store = createToastStore();
    reportSaveOutcome({ status: 'skipped', reason: 'in-flight' }, vi.fn(), store);
    expect(store.getState().visible).toEqual([]);
  });

  it('warns about a restored signed document that cannot be saved in place', () => {
    const store = createToastStore();
    reportSaveOutcome({ status: 'skipped', reason: 'signed-restored' }, vi.fn(), store);
    expect(store.getState().visible[0]?.kind).toBe('warning');
  });
});
