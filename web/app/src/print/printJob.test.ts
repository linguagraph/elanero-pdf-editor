import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { t } from '../i18n/t';
import { RpcError } from '../rpc/client';
import { type PrintRpc, runPrintJob } from './printJob';

const DOC = new Uint8Array([1, 2, 3]).buffer;

// One PNG page header: enough for the size reader.
function pngBytes(): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 150);
  view.setUint32(20, 300);
  return bytes.buffer;
}

function filesReply(names: string[]): string {
  return JSON.stringify({
    v: 1,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: names.map((name) => ({ name, mime: 'image/png', data: { $bin: 0 } })),
      value: { pages: names.length },
      name: '',
    },
    events: [],
  });
}

function workerReplying(reply: string): WorkerClient {
  return {
    call: vi.fn(async () => ({ reply, buffer: pngBytes() })),
    onStage: vi.fn(() => () => undefined),
    terminate: vi.fn(),
  };
}

function rpcWith(token = 'tok-1') {
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
    if (method === 'jobs.prepare')
      return { token, label: 'Print', mutating: false, document: DOC, state: null };
    return { state: null };
  });
  const rpc: PrintRpc = { call: call as unknown as PrintRpc['call'] };
  return { rpc, call };
}

function setup() {
  const toasts = createToastStore();
  return { toasts, store: createJobProgressStore({ toasts }) };
}

const base = {
  handle: 'h1',
  pages: undefined,
  dpi: 150,
  comments: true,
};

describe('runPrintJob', () => {
  it('prepares print_pages with the range and dpi, runs it and hands the pages to the print path', async () => {
    const { rpc, call } = rpcWith();
    const worker = workerReplying(filesReply(['page-01.png']));
    const printFiles = vi.fn(async () => undefined);
    const { store } = setup();

    await runPrintJob({
      ...base,
      rpc,
      pages: [0, 2],
      dpi: 300,
      comments: false,
      startWorker: () => worker,
      store,
      printFiles,
    });

    expect(call).toHaveBeenNthCalledWith(1, 'jobs.prepare', {
      handle: 'h1',
      job: 'print_pages',
      args: { pages: [0, 2], dpi: 300, annotations: false },
    });
    const sent = JSON.parse(String(vi.mocked(worker.call).mock.calls[0]?.[0]));
    expect(sent).toMatchObject({
      method: 'job.run',
      params: { job: 'print_pages', args: { pages: [0, 2], dpi: 300, annotations: false } },
    });
    expect(printFiles).toHaveBeenCalledWith(
      [expect.objectContaining({ name: 'page-01.png', mime: 'image/png' })],
      { dpi: 300 },
    );
    expect(call.mock.calls.map((entry) => entry[0])).toContain('system.memory');
    expect(call).toHaveBeenLastCalledWith('jobs.abort', { handle: 'h1', token: 'tok-1' });
    expect(store.getState().job).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('leaves the pages argument out for every page', async () => {
    const { rpc, call } = rpcWith();
    await runPrintJob({
      ...base,
      rpc,
      startWorker: () => workerReplying(filesReply(['page-01.png'])),
      store: setup().store,
      printFiles: async () => undefined,
    });
    expect(call.mock.calls[0]?.[1]).toEqual({
      handle: 'h1',
      job: 'print_pages',
      args: { dpi: 150, annotations: true },
    });
  });

  it('shows the job in the progress bar while it runs, labelled as printing', async () => {
    const { rpc } = rpcWith();
    const { store } = setup();
    let release: () => void = () => undefined;
    const worker: WorkerClient = {
      call: vi.fn(
        () =>
          new Promise<CallResult>((resolve) => {
            release = () => resolve({ reply: filesReply(['page-01.png']), buffer: pngBytes() });
          }),
      ),
      onStage: vi.fn(() => () => undefined),
      terminate: vi.fn(),
    };
    const run = runPrintJob({
      ...base,
      rpc,
      startWorker: () => worker,
      store,
      printFiles: async () => undefined,
    });
    await vi.waitFor(() => expect(store.getState().job).toBeDefined());
    expect(store.getState().job).toMatchObject({ token: 'tok-1', label: t('print.title') });
    release();
    await run;
    expect(store.getState().job).toBeUndefined();
  });

  it('cancel calls jobs.abort with the token and terminates the job worker', async () => {
    const { rpc, call } = rpcWith();
    const { store } = setup();
    let finish: (value: CallResult) => void = () => undefined;
    const worker: WorkerClient = {
      call: vi.fn(() => new Promise<CallResult>((resolve) => (finish = resolve))),
      onStage: vi.fn(() => () => undefined),
      terminate: vi.fn(() => finish({ reply: '', buffer: undefined })),
    };
    const printFiles = vi.fn(async () => undefined);
    const run = runPrintJob({
      ...base,
      rpc,
      startWorker: () => worker,
      store,
      printFiles,
    });
    await vi.waitFor(() => expect(store.getState().job).toBeDefined());
    await act(async () => {
      await store.cancel();
    });
    expect(call).toHaveBeenCalledWith('jobs.abort', { handle: 'h1', token: 'tok-1' });
    expect(worker.terminate).toHaveBeenCalled();
    expect(store.getState().job).toBeUndefined();
    await run;
    expect(printFiles).not.toHaveBeenCalled();
  });

  it('reports a job failure as an error toast and prints nothing', async () => {
    const { rpc } = rpcWith();
    const { store, toasts } = setup();
    const failure = JSON.stringify({
      v: 1,
      id: 1,
      ok: false,
      error: { code: 'INVALID_ARGS', message: 'bad', details: {} },
    });
    const printFiles = vi.fn(async () => undefined);
    await runPrintJob({
      ...base,
      rpc,
      startWorker: () => workerReplying(failure),
      store,
      toasts,
      printFiles,
    });
    expect(printFiles).not.toHaveBeenCalled();
    expect(toasts.getState().visible.some((toast) => toast.kind === 'error')).toBe(true);
  });

  it('reports a failed prepare and starts no worker', async () => {
    const rpc: PrintRpc = {
      call: (async () => {
        throw new RpcError('INVALID_ARGS', 'nope');
      }) as PrintRpc['call'],
    };
    const startWorker = vi.fn();
    const { store, toasts } = setup();
    await runPrintJob({ ...base, rpc, startWorker, store, toasts });
    expect(startWorker).not.toHaveBeenCalled();
    expect(toasts.getState().visible.some((toast) => toast.kind === 'error')).toBe(true);
  });

  it('reports an error and starts no job when no job worker is available', async () => {
    const { rpc } = rpcWith();
    const { store, toasts } = setup();
    await runPrintJob({ ...base, rpc, startWorker: undefined, store, toasts });
    expect(store.getState().job).toBeUndefined();
    expect(toasts.getState().visible.some((toast) => toast.kind === 'error')).toBe(true);
  });
});
