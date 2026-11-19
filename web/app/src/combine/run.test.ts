import { describe, expect, it, vi } from 'vitest';
import type { CallResult } from '../engine/loader';
import type { WorkerClient } from '../engine/start';
import { createJobProgressStore } from '../feedback/jobRun';
import { createToastStore } from '../feedback/toasts';
import { MAX_FILE_BYTES } from '../documents/openFile';
import { RpcError } from '../rpc/client';
import { t } from '../i18n/t';
import { runCombine } from './run';
import type { SourceItem } from './sources';

// A job worker whose call waits for the test to answer it, so progress can be seen mid-job.
class PendingWorker implements WorkerClient {
  readonly requests: string[] = [];
  readonly terminate = vi.fn();
  private resolveCall: ((result: CallResult) => void) | undefined;
  private rejectCall: ((error: Error) => void) | undefined;

  call(request: string): Promise<CallResult> {
    this.requests.push(request);
    return new Promise<CallResult>((resolve, reject) => {
      this.resolveCall = resolve;
      this.rejectCall = reject;
    });
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
  return { id, name, file: new File([data], name, { type: 'application/pdf' }) };
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

    const job = store.getState().job;
    expect(job?.label).toBe(t('combine.label'));
    store.progress(job?.token ?? '', 40);
    expect(store.getState().job?.percent).toBe(40);

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
