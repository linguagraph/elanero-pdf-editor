// The job worker pool (W3.1 slice 2): one warm job worker per tab, started after the first page is
// drawn, handed to one job at a time and reused when the job was clean and small.
//
// Lease rules, for callers (the job flows do not change):
//  - acquire() gives a lease: a WorkerClient for one job. Call terminate() when the job is over,
//    as the flows already do, in both the Cancel and the finally path.
//  - terminate() discards the worker (a real terminate, and a re-warm when the pool is armed) when
//    the lease still has a call pending (Cancel), when a call rejected, or when the request buffers
//    sent add up to more than reuseMaxBytes (wasm memory never shrinks). Otherwise it releases the
//    worker back to the pool.
//  - A caller that never calls terminate() leaks its lease; the pool then starts another worker.
//    A caller that terminates before its call only releases a worker it never used, which is fine.
//  - Calls on a released or discarded lease reject with 'the worker has been terminated'.
import { CallError } from './errors';
import type { CallResult, Notice } from './loader';
import type { Stage } from './protocol';
import type { WorkerClient } from './start';

// W1.1 section 1, decision 2: an idle job worker is terminated after ten minutes.
export const IDLE_MS = 10 * 60 * 1000;
// Open decision 1: a worker that moved more than 100 MiB in one job is discarded, since its heap
// does not shrink.
export const REUSE_MAX_BYTES = 100 * 1024 * 1024;
// Open decision 2: devices with 2 GB or less skip the warm-up.
const LOW_MEMORY_GB = 2;
const WARM_IDLE_TIMEOUT_MS = 2000;
// The same raw hello the engine answers (protocol v1).
const HELLO = JSON.stringify({ v: 1, id: 0, method: 'hello', params: {} });

export interface JobWorkerPool {
  // A worker for one job. Same shape as startJobWorker's result, so the job flows don't change.
  acquire(): WorkerClient;
  // Starts one worker in the background if none is idle or starting. Idempotent. After the first
  // call the pool is "armed": it re-warms after a discard.
  warm(): void;
  // Terminates the idle worker and stops all timers. Workers out on lease are not touched.
  dispose(): void;
}

export interface JobPoolOptions {
  start: () => WorkerClient;
  idleMs?: number;
  reuseMaxBytes?: number;
  // Defaults to navigator.deviceMemory <= 2 (open decision 2). Where the API is missing, warm.
  lowMemory?: () => boolean;
  // Defaults to requestIdleCallback with a 2 s timeout, else setTimeout(0).
  schedule?: (run: () => void) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

// A worker in the pool: idle once its warm-up hello has answered, or still starting.
interface Slot {
  readonly client: WorkerClient;
  ready: boolean;
}

function deviceIsLowMemory(): boolean {
  const memory = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory;
  return typeof memory === 'number' && memory <= LOW_MEMORY_GB;
}

function defaultSchedule(run: () => void): void {
  const host = globalThis as unknown as {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
  };
  if (typeof host.requestIdleCallback === 'function') {
    // Called as a method: browsers reject an unbound call with "Illegal invocation".
    host.requestIdleCallback(run, { timeout: WARM_IDLE_TIMEOUT_MS });
  } else {
    setTimeout(run, 0);
  }
}

export function createJobWorkerPool(options: JobPoolOptions): JobWorkerPool {
  const idleMs = options.idleMs ?? IDLE_MS;
  const reuseMaxBytes = options.reuseMaxBytes ?? REUSE_MAX_BYTES;
  const lowMemory = options.lowMemory ?? deviceIsLowMemory;
  const schedule = options.schedule ?? defaultSchedule;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  // The one idle or starting worker. At most one exists.
  let slot: Slot | undefined;
  let warmQueued = false;
  let idleTimer: unknown;
  let armed = false;
  let disposed = false;

  const clearIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
  };

  const startIdleTimer = (): void => {
    clearIdleTimer();
    idleTimer = setTimer(() => {
      idleTimer = undefined;
      if (slot === undefined) return;
      const expired = slot;
      slot = undefined;
      expired.client.terminate();
    }, idleMs);
  };

  const warm = (): void => {
    armed = true;
    if (disposed || lowMemory() || slot !== undefined || warmQueued) return;
    warmQueued = true;
    schedule(() => {
      warmQueued = false;
      if (disposed || slot !== undefined) return;
      const entry: Slot = { client: options.start(), ready: false };
      slot = entry;
      entry.client.call(HELLO).then(
        () => {
          // Still the warm worker (not handed out): it is idle now.
          if (slot !== entry) return;
          entry.ready = true;
          startIdleTimer();
        },
        () => {
          // A failed warm-up is dropped quietly. The next acquire starts a cold worker and the job
          // flow reports the real error. A worker already handed out is left to its lease.
          if (slot !== entry) return;
          slot = undefined;
          entry.client.terminate();
        },
      );
    });
  };

  // Puts a worker back as the idle one, or terminates it when one is already there.
  const release = (client: WorkerClient): void => {
    if (disposed || slot !== undefined) {
      client.terminate();
      return;
    }
    slot = { client, ready: true };
    startIdleTimer();
  };

  const discard = (client: WorkerClient): void => {
    client.terminate();
    if (armed) warm();
  };

  const lease = (client: WorkerClient): WorkerClient => {
    let pending = 0;
    let failed = false;
    let sentBytes = 0;
    let terminated = false;
    const unsubscribers: (() => void)[] = [];

    return {
      call(request, buffers = [], onNotice?: (notice: Notice) => void) {
        if (terminated) return Promise.reject(new CallError('the worker has been terminated'));
        for (const buffer of buffers) sentBytes += buffer.byteLength;
        pending += 1;
        return client.call(request, buffers, onNotice).then(
          (result: CallResult) => {
            pending -= 1;
            return result;
          },
          (error: unknown) => {
            pending -= 1;
            failed = true;
            throw error;
          },
        );
      },

      onStage(listener: (stage: Stage) => void) {
        if (terminated) return () => undefined;
        const unsubscribe = client.onStage(listener);
        unsubscribers.push(unsubscribe);
        return () => {
          unsubscribe();
        };
      },

      terminate() {
        if (terminated) return;
        terminated = true;
        for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        if (pending > 0 || failed || sentBytes > reuseMaxBytes) {
          discard(client);
        } else {
          release(client);
        }
      },
    };
  };

  return {
    acquire() {
      if (slot !== undefined) {
        const taken = slot;
        slot = undefined;
        clearIdleTimer();
        return lease(taken.client);
      }
      return lease(options.start());
    },

    warm,

    dispose() {
      disposed = true;
      clearIdleTimer();
      const idle = slot;
      slot = undefined;
      idle?.client.terminate();
    },
  };
}
