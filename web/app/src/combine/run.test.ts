import { describe, expect, it, vi } from 'vitest';
import type { CallResult, Notice } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { MAX_FILE_BYTES } from '../documents/openFile';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import { rangeProblems, runCombine } from './run';
import type { SourceItem } from './sources';

// A job worker whose call waits for the test to answer it, so progress can be seen mid-job.
class PendingWorker implements WorkerClient {
  readonly requests: string[] = [];
  readonly terminate = vi.fn();
  private resolveCall: ((result: CallResult) => void) | undefined;
  private rejectCall: ((error: Error) => void) | undefined;
  private noticeSink: ((notice: Notice) => void) | undefined;

  call(
    request: string,
    _buffers?: readonly ArrayBuffer[],
    onNotice?: (notice: Notice) => void,
  ): Promise<CallResult> {
    this.requests.push(request);
    this.noticeSink = onNotice;
    return new Promise<CallResult>((resolve, reject) => {
      this.resolveCall = resolve;
      this.rejectCall = reject;
    });
  }

  // Sends a notice of the running job, as the job worker does.
  notify(notice: Notice): void {
    this.noticeSink?.(notice);
  }

  answer(result: CallResult): void {
    this.resolveCall?.(result);
  }

  fail(error: Error): void {
    this.rejectCall?.(error);
  }

  onStage(): () => void {
    return () => undefined;
  }
}

function item(id: number, name: string, data = 'x'): SourceItem {
  return { id, name, file: new File([data], name, { type: 'application/pdf' }), pages: '' };
}

function progress(done: number, total: number): Notice {
  return { notice: 'progress', id: 1, data: { done, total, status: '' } };
}

function okReply(bytes: ArrayBuffer): CallResult {
  return {
    reply: JSON.stringify({
      v: 1,
      id: 1,
      ok: true,
      result: {
        kind: 'new_document',
        label: '',
        require_full_save: false,
        document: { $bin: 0 },
        files: [],
        value: null,
        name: 'merged.pdf',
      },
      events: [],
    }),
    buffer: bytes,
  };
}

// Lets the awaited steps before the job's call run (reading the files is asynchronous).
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setup() {
  const toasts = createToastStore();
  const store = createJobProgressStore({ toasts });
  const worker = new PendingWorker();
  const startWorker = vi.fn(() => worker);
  return { toasts, store, worker, startWorker, deps: { store, startWorker } };
}

describe('runCombine', () => {
  it('refuses fewer than two sources before any job starts', async () => {
    const { store, startWorker, deps } = setup();

    const outcome = await runCombine([item(1, 'a.pdf')], deps);

    expect(outcome).toEqual({ status: 'refused', message: t('combine.needTwo') });
    expect(startWorker).not.toHaveBeenCalled();
    expect(store.getState().job).toBeUndefined();
  });

  it('refuses a file above the opening limit before any job starts', async () => {
    const { startWorker, deps } = setup();
    const huge = {
      id: 2,
      name: 'huge.pdf',
      pages: '',
      file: { size: MAX_FILE_BYTES + 1, name: 'huge.pdf' } as unknown as File,
    };

    const outcome = await runCombine([item(1, 'a.pdf'), huge], deps);

    expect(outcome).toEqual({
      status: 'refused',
      message: t('combine.tooLarge', { name: 'huge.pdf' }),
    });
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('runs the merge with the sources in order, shows progress and returns the result', async () => {
    const { store, worker, deps } = setup();
    const output = new Uint8Array([5, 6]).buffer;

    const running = runCombine([item(1, 'b.pdf'), item(2, 'a.pdf')], deps);
    await settle();

    expect(store.getState().job?.label).toBe(t('combine.label'));

    worker.answer(okReply(output));
    const outcome = await running;

    const request = JSON.parse(worker.requests[0] ?? '{}') as {
      params: { args: { sources: { name: string }[] } };
    };
    expect(request.params.args.sources.map((source) => source.name)).toEqual(['b.pdf', 'a.pdf']);
    expect(outcome).toEqual({ status: 'done', name: 'merged.pdf', bytes: output });
    expect(store.getState().job).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('the progress notices move the bar, from 0 to 100', async () => {
    const { store, worker, deps } = setup();

    const running = runCombine([item(1, 'a.pdf'), item(2, 'b.pdf'), item(3, 'c.pdf')], deps);
    await settle();
    expect(store.getState().job?.percent).toBeUndefined();

    worker.notify(progress(0, 3));
    expect(store.getState().job?.percent).toBe(0);
    worker.notify(progress(2, 3));
    expect(store.getState().job?.percent).toBe(67);
    worker.notify(progress(3, 3));
    expect(store.getState().job?.percent).toBe(100);

    worker.answer(okReply(new Uint8Array([1]).buffer));
    await running;
    expect(store.getState().job).toBeUndefined();
  });

  it('a late notice after Cancel does not reach the bar, and the outcome is cancelled', async () => {
    const { store, worker, deps } = setup();

    const running = runCombine([item(1, 'a.pdf'), item(2, 'b.pdf')], deps);
    await settle();
    worker.notify(progress(1, 2));
    expect(store.getState().job?.percent).toBe(50);

    await store.cancel();
    worker.notify(progress(2, 2));
    worker.fail(new Error('the worker has been terminated'));
    const outcome = await running;

    expect(store.getState().job).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('cancel stops the job worker, clears the bar and reports no error', async () => {
    const { toasts, store, worker, deps } = setup();

    const running = runCombine([item(1, 'a.pdf'), item(2, 'b.pdf')], deps);
    await settle();
    await store.cancel();
    worker.fail(new Error('the worker has been terminated'));
    const outcome = await running;

    expect(worker.terminate).toHaveBeenCalled();
    expect(store.getState().job).toBeUndefined();
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(toasts.getState().visible).toEqual([]);
  });

  it('a failed job shows an error toast and reports the RPC error', async () => {
    const { toasts, worker, deps } = setup();

    const running = runCombine([item(1, 'a.pdf'), item(2, 'b.pdf')], deps);
    await settle();
    worker.fail(new RpcError('REFUSED', 'a source is encrypted', {}));
    const outcome = await running;

    expect(outcome.status).toBe('failed');
    const [toast] = toasts.getState().visible;
    expect(toast?.kind).toBe('error');
  });
});

describe('runCombine page ranges', () => {
  it('refuses a Pages box that breaks the rule before any job starts', async () => {
    const { startWorker, deps } = setup();
    const broken = { ...item(1, 'a.pdf'), pages: '3-2' };

    const outcome = await runCombine([broken, item(2, 'b.pdf')], deps);

    expect(outcome).toEqual({
      status: 'rangeError',
      problem: { index: 0, kind: 'invalid', item: '3-2', count: null },
    });
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('ignores the Pages box of an image row and of a PDF row left blank', () => {
    const image = { ...item(1, 'a.png'), pages: 'nonsense' };
    const blank = { ...item(2, 'b.pdf'), pages: '   ' };

    expect(rangeProblems([image, blank])).toEqual([]);
  });

  it('sends the typed ranges for PDF rows that have some, and nothing for the others', async () => {
    const { worker, deps } = setup();
    const ranged = { ...item(1, 'a.pdf'), pages: '2-3' };

    const running = runCombine([ranged, item(2, 'b.pdf'), item(3, 'c.png')], deps);
    await settle();
    worker.answer(okReply(new Uint8Array([1]).buffer));
    await running;

    const request = JSON.parse(worker.requests[0] ?? '{}') as {
      params: { args: { sources: Record<string, unknown>[] } };
    };
    const [first, second, third] = request.params.args.sources;
    expect(first).toEqual({ name: 'a.pdf', data: { $bin: 0 }, ranges: '2-3' });
    expect(second).toEqual({ name: 'b.pdf', data: { $bin: 1 } });
    expect(third).toEqual({ name: 'c.png', data: { $bin: 2 } });
  });

  it('a page_range refusal from the job is a row error with no toast', async () => {
    const { toasts, worker, deps } = setup();
    const ranged = { ...item(2, 'b.pdf'), pages: '1' };

    const running = runCombine([item(1, 'a.pdf'), ranged], deps);
    await settle();
    worker.fail(
      new RpcError('INVALID_ARGS', 'args.sources[1].ranges: outside', {
        path: 'args.sources[1].ranges',
        reason: 'page_range',
        kind: 'out_of_range',
        item: '9',
        page_count: 3,
      }),
    );
    const outcome = await running;

    expect(outcome).toEqual({
      status: 'rangeError',
      problem: { index: 1, kind: 'out_of_range', item: '9', count: 3 },
    });
    expect(toasts.getState().visible).toEqual([]);
  });

  it('another INVALID_ARGS still shows an error toast', async () => {
    const { toasts, worker, deps } = setup();

    const running = runCombine([item(1, 'a.pdf'), item(2, 'b.pdf')], deps);
    await settle();
    worker.fail(new RpcError('INVALID_ARGS', 'args.sources: no sources', { path: 'args.sources' }));
    const outcome = await running;

    expect(outcome.status).toBe('failed');
    expect(toasts.getState().visible[0]?.kind).toBe('error');
  });
});
