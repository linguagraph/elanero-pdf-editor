import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { PrintRpc } from './printJob';
import { runPrintJob } from './printJob';
import { runPrintWorker } from './printWorker';

const DOC = new Uint8Array([1, 2, 3]).buffer;

// A page's bytes, tagged so each buffer is distinct and can be told apart after the copy.
function pageBytes(tag: number): ArrayBuffer {
  return new Uint8Array([tag, tag, tag, tag]).buffer;
}

// The job worker's reply to a three-page print: one file per page, each naming its own buffer.
function threePageReply(): string {
  return JSON.stringify({
    v: 1,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [0, 1, 2].map((index) => ({
        name: `page-0${index + 1}.png`,
        mime: 'image/png',
        data: { $bin: index },
      })),
      value: { pages: 3 },
      name: '',
    },
    events: [],
  });
}

function workerReplying(reply: string, buffers: ArrayBuffer[]): WorkerClient {
  const result: CallResult = { reply, buffer: buffers[0], buffers };
  return {
    call: vi.fn(async () => result),
    onStage: vi.fn(() => () => undefined),
    terminate: vi.fn(),
  };
}

function rpcWith(token = 'tok-1'): PrintRpc {
  const call = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async (method) => {
    if (method === 'jobs.prepare')
      return { token, label: 'Print', mutating: false, document: DOC, state: null };
    return { state: null };
  });
  return { call: call as unknown as PrintRpc['call'] };
}

describe('runPrintWorker', () => {
  it('reads every page buffer, in $bin order, not only the first', async () => {
    const buffers = [pageBytes(1), pageBytes(2), pageBytes(3)];
    const worker = workerReplying(threePageReply(), buffers);

    const files = await runPrintWorker(
      worker,
      { dpi: 150, annotations: false, pages: [0, 1, 2] },
      DOC,
    );

    expect(files.map((file) => file.name)).toEqual(['page-01.png', 'page-02.png', 'page-03.png']);
    expect(files.map((file) => file.mime)).toEqual(['image/png', 'image/png', 'image/png']);
    expect(files[0]?.data).toBe(buffers[0]);
    expect(files[1]?.data).toBe(buffers[1]);
    expect(files[2]?.data).toBe(buffers[2]);
  });
});

describe('runPrintJob with a multi-page job', () => {
  it('hands all three page buffers to the print path', async () => {
    const buffers = [pageBytes(1), pageBytes(2), pageBytes(3)];
    const worker = workerReplying(threePageReply(), buffers);
    const printFiles = vi.fn(async () => undefined);
    const toasts = createToastStore();

    await runPrintJob({
      rpc: rpcWith(),
      handle: 'h1',
      pages: [0, 1, 2],
      dpi: 150,
      comments: false,
      startWorker: () => worker,
      store: createJobProgressStore({ toasts }),
      toasts,
      printFiles,
    });

    expect(printFiles).toHaveBeenCalledTimes(1);
    const [files] = printFiles.mock.calls[0] as unknown as [{ name: string; data: ArrayBuffer }[]];
    expect(files.map((file) => file.name)).toEqual(['page-01.png', 'page-02.png', 'page-03.png']);
    expect(files.map((file) => file.data)).toEqual(buffers);
    expect(new Set(files.map((file) => file.data)).size).toBe(3);
  });
});
