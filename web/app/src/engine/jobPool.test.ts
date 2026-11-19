import { describe, expect, it, vi } from 'vitest';
import { CallError } from './errors';
import { createJobWorkerPool, type JobPoolOptions } from './jobPool';
import type { CallResult } from './loader';
import type { WorkerClient } from './start';

interface PendingCall {
  request: string;
  buffers: readonly ArrayBuffer[];
  resolve(result: CallResult): void;
  reject(error: Error): void;
}

// A fake job worker: each call waits until the test answers it, as the real worker does in order.
function fakeWorker() {
  const calls: PendingCall[] = [];
  const worker = {
    call: vi.fn(
      (request: string, buffers: readonly ArrayBuffer[] = []) =>
        new Promise<CallResult>((resolve, reject) => {
          calls.push({ request, buffers, resolve, reject });
        }),
    ),
    onStage: vi.fn(() => () => undefined),
    terminate: vi.fn(() => {
      for (const call of calls.splice(0))
        call.reject(new CallError('the worker has been terminated'));
    }),
  };
  const answer = (index: number) => calls[index]?.resolve({ reply: '{}' });
  const refuse = (index: number) => calls[index]?.reject(new CallError('the worker failed'));
  return { worker, calls, answer, refuse, client: worker as unknown as WorkerClient };
}

// A timer that only runs when the test fires it.
function manualTimers() {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    setTimer: (run: () => void) => {
      const id = next++;
      timers.set(id, run);
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    fire: () => {
      for (const [id, run] of [...timers]) {
        timers.delete(id);
        run();
      }
    },
    count: () => timers.size,
  };
}

// Lets the promise callbacks of a warm-up or a reply run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const HELLO_PATTERN = /"hello"/;

function setup(extra: Partial<JobPoolOptions> = {}) {
  const made: ReturnType<typeof fakeWorker>[] = [];
  const timers = manualTimers();
  const start = vi.fn(() => {
    const fake = fakeWorker();
    made.push(fake);
    return fake.client;
  });
  const pool = createJobWorkerPool({
    start,
    schedule: (run) => run(),
    lowMemory: () => false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...extra,
  });
  return { pool, start, made, timers };
}

describe('job worker pool: acquire and warm', () => {
  it('starts a cold worker when nothing is warm', () => {
    const { pool, start } = setup();
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('warms one worker with one hello, and a second warm does nothing', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    pool.warm();
    expect(start).toHaveBeenCalledTimes(1);
    expect(made[0]!.calls).toHaveLength(1);
    expect(made[0]!.calls[0]!.request).toMatch(HELLO_PATTERN);
    made[0]!.answer(0);
    await settle();
    pool.warm();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('hands out the warm worker without starting a new one', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    const lease = pool.acquire();
    expect(start).toHaveBeenCalledTimes(1);
    void lease.call('{"method":"job.run"}');
    expect(made[0]!.calls).toHaveLength(2);
  });

  it('hands out a worker that is still warming up', () => {
    const { pool, start, made } = setup();
    pool.warm();
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(1);
    expect(made[0]!.calls).toHaveLength(1);
  });
});

describe('job worker pool: release and discard', () => {
  it('puts a worker back after a settled call, so the next acquire reuses it', async () => {
    const { pool, start, made } = setup();
    const first = pool.acquire();
    const pending = first.call('{"method":"job.run"}');
    made[0]!.answer(0);
    await pending;
    first.terminate();
    expect(made[0]!.worker.terminate).not.toHaveBeenCalled();
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('discards and re-warms a worker when a call is pending at terminate (Cancel)', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    const lease = pool.acquire();
    void lease.call('{"method":"job.run"}').catch(() => undefined);
    lease.terminate();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(made[1]!.calls[0]!.request).toMatch(HELLO_PATTERN);
  });

  it('discards a worker whose call rejected', async () => {
    const { pool, start, made } = setup();
    const lease = pool.acquire();
    const failing = lease.call('{"method":"job.run"}');
    made[0]!.refuse(0);
    await expect(failing).rejects.toThrow('the worker failed');
    lease.terminate();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('discards a worker that moved more than reuseMaxBytes', async () => {
    const { pool, start, made } = setup({ reuseMaxBytes: 10 });
    const lease = pool.acquire();
    const pending = lease.call('{"method":"job.run"}', [new ArrayBuffer(16)]);
    made[0]!.answer(0);
    await pending;
    lease.terminate();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe('job worker pool: lease after terminate', () => {
  it('does nothing on a second terminate', async () => {
    const { pool, made } = setup();
    const lease = pool.acquire();
    lease.terminate();
    lease.terminate();
    expect(made[0]!.worker.terminate).not.toHaveBeenCalled();
    pool.acquire();
    expect(made).toHaveLength(1);
  });

  it('rejects a call after terminate with the terminated text', async () => {
    const { pool } = setup();
    const lease = pool.acquire();
    lease.terminate();
    await expect(lease.call('{"method":"job.run"}')).rejects.toThrow(
      'the worker has been terminated',
    );
  });
});

describe('job worker pool: timers and limits', () => {
  it('terminates the idle worker after the idle timeout, and the next acquire is cold', async () => {
    const { pool, start, made, timers } = setup({ idleMs: 1000 });
    pool.warm();
    made[0]!.answer(0);
    await settle();
    expect(timers.count()).toBe(1);
    timers.fire();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not warm when the device has low memory', () => {
    const { pool, start } = setup({ lowMemory: () => true });
    pool.warm();
    expect(start).not.toHaveBeenCalled();
  });

  it('dispose leaves a worker on lease alone, and terminates it when released', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    const lease = pool.acquire();
    pool.dispose();
    expect(made[0]!.worker.terminate).not.toHaveBeenCalled();
    lease.terminate();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('dispose is idempotent', async () => {
    const { pool, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    pool.dispose();
    pool.dispose();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a warm after dispose re-arms the pool and starts exactly one worker', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    pool.dispose();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    pool.warm();
    pool.warm();
    expect(start).toHaveBeenCalledTimes(2);
    made[1]!.answer(0);
    await settle();
    expect(made[1]!.worker.terminate).not.toHaveBeenCalled();
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a lease released after dispose terminates its worker and does not re-warm', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    const lease = pool.acquire();
    pool.dispose();
    lease.terminate();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('dispose terminates an idle worker', async () => {
    const { pool, made } = setup();
    pool.warm();
    made[0]!.answer(0);
    await settle();
    pool.dispose();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('a warm-up whose hello fails is discarded quietly', async () => {
    const { pool, start, made } = setup();
    pool.warm();
    made[0]!.refuse(0);
    await settle();
    expect(made[0]!.worker.terminate).toHaveBeenCalledTimes(1);
    pool.acquire();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
