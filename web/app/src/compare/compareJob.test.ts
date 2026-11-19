import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { RpcError } from '../rpc/client';
import { PROTOCOL_VERSION } from '../rpc/generated';
import type { JobWorker, SplitEngine } from '../split/splitJob';
import { CompareCancelled, compareArgs, readCompareReply, runCompare } from './compareJob';

const OLD_BYTES = new Uint8Array([37, 80, 68, 70, 1]).buffer;
const NEW_BYTES = new Uint8Array([37, 80, 68, 70, 2, 3]).buffer;

// A report reply as the job worker writes it: page 1 changed, page 2 only in the newer document.
function reportReply(value: unknown = REPORT_VALUE): CallResult {
  const reply = {
    v: PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result: {
      kind: 'report',
      label: '',
      require_full_save: false,
      document: null,
      files: [],
      value,
      name: '',
    },
    events: [],
  };
  return { reply: JSON.stringify(reply) };
}

const REPORT_VALUE = {
  identical: false,
  pairs: [
    [0, 0],
    [1, null],
  ],
  changes: [
    { kind: 'replaced', page_a: 0, page_b: 0, summary: "'old' -> 'new'" },
    { kind: 'page inserted', page_a: null, page_b: 1, summary: 'page 2 added' },
  ],
};

function fakeEngine(): SplitEngine & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn(async (method: string) => {
    if (method === 'jobs.prepare') {
      return {
        token: 'j1',
        label: 'compare',
        mutating: false,
        document: OLD_BYTES.slice(0),
        state: null,
      };
    }
    return { applied: false, changed: null, state: null };
  });
  return { call } as unknown as SplitEngine & { call: ReturnType<typeof vi.fn> };
}

function fakeWorker(reply: Promise<CallResult> | CallResult = reportReply()): JobWorker & {
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

const OPTIONS = { text: true, visual: false };

describe('compareArgs', () => {
  it('sends both switches, so the job never relies on a default', () => {
    expect(compareArgs(OPTIONS)).toEqual({ text: true, visual: false });
  });
});

describe('readCompareReply', () => {
  it('reads the pages, the changes and the identical flag', () => {
    expect(readCompareReply(reportReply())).toEqual({
      identical: false,
      pairs: [
        [0, 0],
        [1, null],
      ],
      changes: [
        { kind: 'replaced', pageA: 0, pageB: 0, summary: "'old' -> 'new'" },
        { kind: 'page inserted', pageA: null, pageB: 1, summary: 'page 2 added' },
      ],
    });
  });

  it('refuses a result that is not a report', () => {
    const reply = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: true,
      result: {
        kind: 'files',
        label: '',
        require_full_save: false,
        document: null,
        files: [],
        value: null,
        name: '',
      },
      events: [],
    });
    expect(() => readCompareReply({ reply })).toThrow('a compare returns a report');
  });

  it('turns an error reply into the RPC error', () => {
    const reply = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 1,
      ok: false,
      error: { code: 'REFUSED', message: 'the newer document is encrypted', details: {} },
      events: [],
    });
    expect(() => readCompareReply({ reply })).toThrow(RpcError);
  });
});

describe('runCompare', () => {
  it('calls jobs.prepare, job.run and jobs.apply, sending the newer document as a buffer', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker();
    const progress = store();

    const report = await runCompare(
      { engine, startWorker: () => worker, progress },
      'doc-1',
      NEW_BYTES,
      OPTIONS,
    );

    expect(engine.call.mock.calls.map((entry) => entry[0])).toEqual(['jobs.prepare', 'jobs.apply']);
    expect(engine.call.mock.calls[0]?.[1]).toMatchObject({
      handle: 'doc-1',
      job: 'compare',
      args: { text: true, visual: false },
    });
    const [request, buffers] = worker.call.mock.calls[0] as unknown as [string, ArrayBuffer[]];
    expect(JSON.parse(request)).toMatchObject({
      method: 'job.run',
      params: {
        job: 'compare',
        args: { text: true, visual: false, other: { $bin: 1 } },
        document: { $bin: 0 },
      },
    });
    expect(buffers[0]).toBeInstanceOf(ArrayBuffer);
    expect(buffers[1]).toBe(NEW_BYTES);
    expect(report.changes).toHaveLength(2);
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('shows the job on the progress bar while it runs', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker(new Promise<CallResult>(() => undefined));
    const progress = store();

    void runCompare({ engine, startWorker: () => worker, progress }, 'doc-1', NEW_BYTES, OPTIONS);
    await vi.waitFor(() => expect(progress.getState().job).toBeDefined());

    expect(progress.getState().job?.label).toBe('compare');
  });

  it('cancel calls jobs.abort, stops the worker and ends as cancelled', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker(new Promise<CallResult>(() => undefined));
    const progress = store();
    const running = runCompare(
      { engine, startWorker: () => worker, progress },
      'doc-1',
      NEW_BYTES,
      OPTIONS,
    );
    await vi.waitFor(() => expect(progress.getState().job).toBeDefined());

    await progress.cancel();

    expect(engine.call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(worker.terminate).toHaveBeenCalled();
    await expect(running).rejects.toBeInstanceOf(CompareCancelled);
    expect(progress.getState().job).toBeUndefined();
  });

  it('refuses a second job while one runs, and aborts the one it prepared', async () => {
    const engine = fakeEngine();
    const progress = store();
    progress.begin({ handle: 'doc-1', token: 'other', label: 'split' });

    await expect(
      runCompare(
        { engine, startWorker: () => fakeWorker(), progress },
        'doc-1',
        NEW_BYTES,
        OPTIONS,
      ),
    ).rejects.toMatchObject({ code: 'BUSY' });
    expect(engine.call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
  });

  it('a failed job reports its error, aborts the prepared job and rejects', async () => {
    const engine = fakeEngine();
    const worker = fakeWorker();
    worker.call.mockImplementation(() =>
      Promise.reject(new RpcError('INTERNAL', 'the comparison broke')),
    );
    const progress = store();

    await expect(
      runCompare({ engine, startWorker: () => worker, progress }, 'doc-1', NEW_BYTES, OPTIONS),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(engine.call).toHaveBeenCalledWith('jobs.abort', { handle: 'doc-1', token: 'j1' });
    expect(progress.getState().job).toBeUndefined();
  });
});
