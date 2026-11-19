import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { ReplyShapeError } from '../rpc/shape';
import { PROTOCOL_VERSION } from '../rpc/generated';
import {
  readRunReply,
  runSplit,
  SplitCancelled,
  splitArgs,
  type JobWorker,
  type SplitEngine,
} from './splitJob';

const PDF_BYTES = new Uint8Array([37, 80, 68, 70]).buffer;

function runReply(files: unknown[], buffers: ArrayBuffer[] = [PDF_BYTES]): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'files',
      label: '',
      require_full_save: false,
      document: null,
      files,
      value: null,
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply), buffers };
}

const ONE_FILE = runReply([
  { name: 'split/part-1.pdf', mime: 'application/pdf', data: { $bin: 0 } },
]);

// The engine calls in order, with the prepared document the job worker gets.
function fakeEngine(): SplitEngine & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'split',
        mutating: false,
        document: PDF_BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call } as unknown as SplitEngine & { call: ReturnType<typeof vi.fn> };
}

function fakeWorker(reply: Promise<CallResult> | CallResult = ONE_FILE): JobWorker & {
  call: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
} {
  return {
    call: vi.fn(() => Promise.resolve(reply)),
    terminate: vi.fn(),
  } as unknown as JobWorker & {
    call: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

function store() {
  return createJobProgressStore({ toasts: createToastStore() });
}

describe('splitArgs', () => {
  it('sends every field the job takes, with the mode of the choice', () => {
    expect(splitArgs({ mode: 'pages', pagesPerFile: 2 })).toEqual({
      mode: 'pages',
      pages_per_file: 2,
      ranges: [],
      max_bytes: 0,
    });
    expect(splitArgs({ mode: 'ranges', parts: [[0, 1], [4]] })).toEqual({
      mode: 'ranges',
      pages_per_file: 1,
      ranges: [[0, 1], [4]],
      max_bytes: 0,
    });
    expect(splitArgs({ mode: 'bookmarks' })).toMatchObject({ mode: 'bookmarks' });
    expect(splitArgs({ mode: 'size', maxBytes: 500 })).toMatchObject({
      mode: 'size',
      max_bytes: 500,
    });
  });
});

describe('runSplit', () => {
  it('calls jobs.prepare, job.run and jobs.apply in order, with the arguments', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker();
    const progress = store();

    const files = await runSplit({ engine, startWorker: () => worker, progress }, 'doc-1', {
      mode: 'ranges',
      parts: [[0, 1, 2], [4]],
    });

    expect(engine.call.mock.calls.map((call) => call[0])).toEqual(['jobs.prepare', 'jobs.apply']);
    expect(engine.call.mock.calls[0]?.[1]).toEqual({
      handle: 'doc-1',
      job: 'split',
      args: expect.objectContaining({ mode: 'ranges', ranges: [[0, 1, 2], [4]] }),
    });
    expect(engine.call.mock.calls[1]?.[1]).toEqual({
      handle: 'doc-1',
      token: 'j1',
      document: null,
      label: '',
      require_full_save: false,
    });
    const [request, buffers] = worker.call.mock.calls[0] as [string, ArrayBuffer[]];
    expect(JSON.parse(request)).toMatchObject({
      method: 'job.run',
      params: { job: 'split', document: { $bin: 0 } },
    });
    expect(buffers).toHaveLength(1);
    expect(buffers[0]?.byteLength).toBe(PDF_BYTES.byteLength);
    expect(files).toEqual([{ name: 'split/part-1.pdf', mime: 'application/pdf', data: PDF_BYTES }]);
    expect(progress.getState().job).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('shows the job on the progress bar while it runs', async () => {
    let finish: (result: CallResult) => void = () => undefined;
    const pending = new Promise<CallResult>((resolve) => {
      finish = resolve;
    });
    const progress = store();
    const running = runSplit(
      { engine: fakeEngine(), startWorker: () => fakeWorker(pending), progress },
      'doc-1',
      { mode: 'bookmarks' },
    );
    await vi.waitFor(() => expect(progress.getState().job?.token).toBe('j1'));
    expect(progress.getState().job?.label).toBe('split');
    finish(ONE_FILE);
    await running;
  });

  it('cancel calls jobs.abort, stops the worker and ends as cancelled', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker(new Promise<CallResult>(() => undefined));
    const progress = store();
    const running = runSplit({ engine, startWorker: () => worker, progress }, 'doc-1', {
      mode: 'pages',
      pagesPerFile: 1,
    });
    await vi.waitFor(() => expect(progress.getState().job).toBeDefined());

    await progress.cancel();

    expect(engine.call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(worker.terminate).toHaveBeenCalled();
    await expect(running).rejects.toBeInstanceOf(SplitCancelled);
    expect(progress.getState().job).toBeUndefined();
  });

  it('refuses a second job while one runs, and aborts the one it prepared', async () => {
    const progress = store();
    progress.begin({
      handle: 'doc-1',
      token: 'other',
      label: 'compare',
      client: { call: vi.fn(async () => ({})) },
    });
    const engine = fakeEngine();
    await expect(
      runSplit({ engine, startWorker: () => fakeWorker(), progress }, 'doc-1', {
        mode: 'bookmarks',
      }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(engine.call).toHaveBeenLastCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
  });

  it('a failed job reports its error, aborts the prepared job and rejects', async () => {
    const engine = fakeEngine();
    const error = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: false,
      error: { code: 'INVALID_ARGS', message: 'args.ranges: bad', details: {} },
      events: [],
    });
    const progress = store();
    await expect(
      runSplit(
        { engine, startWorker: () => fakeWorker({ reply: error, buffer: undefined }), progress },
        'doc-1',
        { mode: 'bookmarks' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(engine.call).toHaveBeenLastCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(progress.getState().job).toBeUndefined();
  });
});

describe('readRunReply', () => {
  it('reads one file and its bytes', () => {
    expect(readRunReply(ONE_FILE)).toEqual([
      { name: 'split/part-1.pdf', mime: 'application/pdf', data: PDF_BYTES },
    ]);
  });

  it('reads several files, each from its own buffer in $bin order', () => {
    const second = new Uint8Array([9, 9]).buffer;
    const two = runReply(
      [
        { name: 'a.pdf', mime: 'application/pdf', data: { $bin: 0 } },
        { name: 'b.pdf', mime: 'application/pdf', data: { $bin: 1 } },
      ],
      [PDF_BYTES, second],
    );
    expect(readRunReply(two)).toEqual([
      { name: 'a.pdf', mime: 'application/pdf', data: PDF_BYTES },
      { name: 'b.pdf', mime: 'application/pdf', data: second },
    ]);
  });

  it('refuses a file whose buffer is missing from the reply', () => {
    const missing = runReply([{ name: 'a.pdf', mime: 'application/pdf', data: { $bin: 1 } }]);
    expect(() => readRunReply(missing)).toThrow(ReplyShapeError);
  });

  it('refuses a result that is not files', () => {
    const reply = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: {
        kind: 'document',
        label: 'x',
        require_full_save: false,
        document: null,
        files: [],
        value: null,
        name: '',
      },
      events: [],
    });
    expect(() => readRunReply({ reply })).toThrow();
  });
});
