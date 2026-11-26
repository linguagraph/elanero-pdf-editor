import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { CallError } from '../engine/errors';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import type { PrintRpc } from './printJob';
import { runPrintJob } from './printJob';
import { runPrintWorker } from './printWorker';
import { t } from '../i18n/t';

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

  it('fails naming the page when its $bin marker points past the buffers', async () => {
    // Three buffers, but the page's marker says $bin 5: the reply does not carry that page.
    const reply = JSON.stringify({
      v: 1,
      id: 1,
      ok: true,
      result: {
        kind: 'files',
        label: '',
        require_full_save: false,
        document: null,
        files: [{ name: 'page-06.png', mime: 'image/png', data: { $bin: 5 } }],
        value: { pages: 1 },
        name: '',
      },
      events: [],
    });
    const worker = workerReplying(reply, [pageBytes(1), pageBytes(2), pageBytes(3)]);

    await expect(
      runPrintWorker(worker, { dpi: 150, annotations: false, pages: [5] }, DOC),
    ).rejects.toThrow('the print job replied badly: page page-06.png is not in the reply');
  });

  it('fails naming the page when the reply carries no buffers at all', async () => {
    const worker = workerReplying(threePageReply(), []);

    await expect(
      runPrintWorker(worker, { dpi: 150, annotations: false, pages: [0, 1, 2] }, DOC),
    ).rejects.toThrow('the print job replied badly: page page-01.png is not in the reply');
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

// A job worker that sends the given notices, in order, before its reply.
function streamingWorker(
  notices: ReadonlyArray<readonly [Record<string, unknown>, ArrayBuffer?]>,
  reply: string,
): WorkerClient {
  return {
    call: async (_request, _buffers, onNotice) => {
      for (const [notice, buffer] of notices) onNotice?.(notice, buffer);
      return { reply };
    },
    onStage: () => () => undefined,
    terminate: vi.fn(),
  };
}

function partial(index: number, name = `page-0${index + 1}.png`) {
  return {
    notice: 'partial',
    id: 1,
    data: { index, name, mime: 'image/png', data: { $bin: 0 } },
  };
}

function replyWithPages(pages: number): string {
  return JSON.stringify({
    v: 1,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files: [],
      value: { pages },
      name: '',
    },
    events: [],
  });
}

describe('runPrintWorker with partial notices', () => {
  it('collects the pages in order and reports the progress notices', async () => {
    const onProgress = vi.fn();
    const worker = streamingWorker(
      [
        [{ notice: 'progress', id: 1, data: { done: 1, total: 3, status: '' } }],
        [partial(0), pageBytes(1)],
        [{ notice: 'progress', id: 1, data: { done: 2, total: 3, status: '' } }],
        [partial(1), pageBytes(2)],
        [partial(2), pageBytes(3)],
      ],
      replyWithPages(3),
    );

    const files = await runPrintWorker(
      worker,
      { dpi: 150, annotations: true, pages: [0, 1, 2] },
      DOC,
      onProgress,
    );

    expect(files.map((file) => file.name)).toEqual(['page-01.png', 'page-02.png', 'page-03.png']);
    expect(files[2]?.data).toEqual(pageBytes(3));
    expect(onProgress.mock.calls.map((call) => call[0])).toEqual([33, 67]);
  });

  it('fails when a page arrives out of order', async () => {
    const worker = streamingWorker([[partial(1), pageBytes(1)]], replyWithPages(1));
    await expect(runPrintWorker(worker, { dpi: 150, annotations: true }, DOC)).rejects.toThrow(
      'page 1 arrived out of order',
    );
  });

  it('fails when a page has no bytes', async () => {
    const worker = streamingWorker([[partial(0)]], replyWithPages(1));
    await expect(runPrintWorker(worker, { dpi: 150, annotations: true }, DOC)).rejects.toThrow(
      'has no bytes',
    );
  });

  // Pins the current behaviour: printWorker.ts refuses any partial page whose mime is not image/png,
  // even when its bytes arrive, so the print path never gets a PDF page.
  it('refuses a partial page whose mime is application/pdf: a page is not a PNG', async () => {
    const pdfPage = {
      notice: 'partial',
      id: 1,
      data: { index: 0, name: 'page-01.pdf', mime: 'application/pdf', data: { $bin: 0 } },
    };
    const worker = streamingWorker([[pdfPage, pageBytes(1)]], replyWithPages(1));
    await expect(runPrintWorker(worker, { dpi: 150, annotations: true }, DOC)).rejects.toThrow(
      'the print job replied badly: a page is not a PNG',
    );
  });

  it('stops at the first bad partial: the worker is terminated and no later page is taken', async () => {
    // As the real worker does, this one rejects its call once it is terminated, and delivers no
    // notice after that. The first partial is out of order, so the job must stop there.
    const delivered: Record<string, unknown>[] = [];
    let terminated = false;
    const terminate = vi.fn(() => {
      terminated = true;
    });
    const notices: ReadonlyArray<readonly [Record<string, unknown>, ArrayBuffer?]> = [
      [partial(1), pageBytes(1)],
      [partial(0), pageBytes(2)],
      [partial(1), pageBytes(3)],
      [partial(2), pageBytes(4)],
    ];
    const worker: WorkerClient = {
      call: async (_request, _buffers, onNotice) => {
        for (const [notice, buffer] of notices) {
          if (terminated) throw new CallError('the worker has been terminated');
          delivered.push(notice);
          onNotice?.(notice, buffer);
        }
        return { reply: replyWithPages(3) };
      },
      onStage: () => () => undefined,
      terminate,
    };

    await expect(runPrintWorker(worker, { dpi: 150, annotations: true }, DOC)).rejects.toThrow(
      'page 1 arrived out of order',
    );
    expect(terminate).toHaveBeenCalledTimes(1);
    // Only the bad partial was delivered; the three after it never reached the handler.
    expect(delivered).toHaveLength(1);
  });

  it('fails rather than print a short document when a partial was dropped', async () => {
    const worker = streamingWorker(
      [
        [partial(0), pageBytes(1)],
        [partial(1), pageBytes(2)],
      ],
      replyWithPages(3),
    );
    await expect(runPrintWorker(worker, { dpi: 150, annotations: true }, DOC)).rejects.toThrow(
      t('print.mismatch'),
    );
  });
});
