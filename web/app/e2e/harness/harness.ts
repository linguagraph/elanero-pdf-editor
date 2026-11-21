// Test-only page script (W3.1): starts the engine and the job worker through the real start.ts,
// and reports what the browser test needs. The Playwright test reads window.__harness.
import { EngineLoadError } from '../../src/engine/errors';
import { createJobWorkerPool, type JobWorkerPool } from '../../src/engine/jobPool';
import { startEngine, startJobWorker, type WorkerClient } from '../../src/engine/start';
import type { Stage } from '../../src/engine/protocol';
import { createJobProgressStore } from '../../src/feedback/jobRun';
import { RpcClient } from '../../src/rpc/client';
import { runSplit } from '../../src/split/splitJob';

const ASSET_BASE = new URL('/engine-assets/', location.href).href;
const HELLO = JSON.stringify({ v: 1, id: 99, method: 'hello', params: {} });

export interface BootReport {
  stages: Stage[];
  // Milliseconds from start until the 'ready' stage arrived.
  readyMs: number | null;
  hello?: unknown;
  error?: { name: string; message: string; stage?: string; code?: string };
}

function describe(error: unknown): BootReport['error'] {
  if (error instanceof EngineLoadError) {
    return { name: error.name, message: error.message, stage: error.stage };
  }
  const named = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: typeof named.name === 'string' ? named.name : 'Error',
    message: typeof named.message === 'string' ? named.message : String(error),
    code: typeof named.code === 'string' ? named.code : undefined,
  };
}

function track(client: WorkerClient): { stages: Stage[]; readyAt: () => number | null } {
  const stages: Stage[] = [];
  const started = performance.now();
  let readyAt: number | null = null;
  client.onStage((stage) => {
    stages.push(stage);
    if (stage === 'ready') readyAt = Math.round(performance.now() - started);
  });
  return { stages, readyAt: () => readyAt };
}

// The engine worker through the RPC client: stages, then hello.
async function bootEngine(): Promise<BootReport> {
  const client = startEngine({
    workerUrl: '/src/engine/engine.worker.ts',
    assetBaseUrl: ASSET_BASE,
  });
  const seen = track(client);
  try {
    const hello = await new RpcClient(client).call('hello', {});
    return { stages: seen.stages, readyMs: seen.readyAt(), hello };
  } catch (error) {
    return { stages: seen.stages, readyMs: seen.readyAt(), error: describe(error) };
  }
}

// The job worker: the same bootstrap, with the lockdown before the engine stage. It stays alive
// until stopJob(), so the test can look inside it (Playwright evaluates in dedicated workers).
let job: WorkerClient | undefined;

async function bootJob(): Promise<BootReport> {
  const client = startJobWorker({
    workerUrl: '/src/engine/jobworker.ts',
    assetBaseUrl: ASSET_BASE,
  });
  job = client;
  const seen = track(client);
  try {
    const hello = await new RpcClient(client).call('hello', {});
    return { stages: seen.stages, readyMs: seen.readyAt(), hello };
  } catch (error) {
    return { stages: seen.stages, readyMs: seen.readyAt(), error: describe(error) };
  }
}

function stopJob(): void {
  job?.terminate();
  job = undefined;
}

// The raw path of startEngine: no RPC client in between, so a load failure keeps its stage.
async function rawHello(assetBaseUrl: string): Promise<BootReport> {
  const client = startEngine({ workerUrl: '/src/engine/engine.worker.ts', assetBaseUrl });
  const seen = track(client);
  try {
    const result = await client.call(HELLO);
    return { stages: seen.stages, readyMs: seen.readyAt(), hello: JSON.parse(result.reply) };
  } catch (error) {
    return { stages: seen.stages, readyMs: seen.readyAt(), error: describe(error) };
  } finally {
    client.terminate();
  }
}

// One split through the app's own job flow (splitJob.ts, fileJob.ts): the engine opens the PDF,
// jobs.prepare takes the copy, job.run runs in the job worker, and jobs.apply ends the job. The
// report says what the browser got back; the bytes stay in the page.
export interface SplitReport {
  files?: { name: string; mime: string; size: number; header: string }[];
  // The bar's percent values in order, from the job's progress notices.
  percents: number[];
  error?: { name: string; message: string; code?: string };
}

async function runSplitJob(pdfBase64: string, name: string): Promise<SplitReport> {
  const pdf = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0)).buffer;
  const engineWorker = startEngine({
    workerUrl: '/src/engine/engine.worker.ts',
    assetBaseUrl: ASSET_BASE,
  });
  const engine = new RpcClient(engineWorker);
  const progress = createJobProgressStore();
  const percents: number[] = [];
  progress.subscribe(() => {
    const percent = progress.getState().job?.percent;
    if (percent !== undefined && percents.at(-1) !== percent) percents.push(percent);
  });
  try {
    const opened = await engine.call('session.open', { name, data: pdf, password: null });
    const files = await runSplit(
      {
        engine,
        progress,
        startWorker: () =>
          startJobWorker({ workerUrl: '/src/engine/jobworker.ts', assetBaseUrl: ASSET_BASE }),
      },
      opened.handle,
      { mode: 'pages', pagesPerFile: 1 },
      { name, zip: false },
    );
    const decoder = new TextDecoder('latin1');
    return {
      files: files.map((file) => ({
        name: file.name,
        mime: file.mime,
        size: file.data.byteLength,
        header: decoder.decode(file.data.slice(0, 5)),
      })),
      percents,
    };
  } catch (error) {
    return { percents, error: describe(error) };
  } finally {
    engineWorker.terminate();
  }
}

// The job worker pool (W3.1 slice 2) over the real job worker. The warm-up runs at once, so the
// test does not wait on an idle callback. The pool is kept until poolStop(), so the test can look
// inside the job worker it reused.
let pool: JobWorkerPool | undefined;

function newPool(): JobWorkerPool {
  pool?.dispose();
  pool = createJobWorkerPool({
    start: () =>
      startJobWorker({ workerUrl: '/src/engine/jobworker.ts', assetBaseUrl: ASSET_BASE }),
    schedule: (run) => run(),
    // The device policy (no warm-up at 2 GB or less) is unit-tested; the browser run checks the
    // pool itself, whatever memory the test machine reports.
    lowMemory: () => false,
  });
  return pool;
}

export interface PoolReuseReport {
  // The number of files each job produced, in run order.
  files: number[];
  error?: { name: string; message: string; code?: string };
}

// Two splits through the pool: the warm worker takes the first job, and the second job reuses the
// same worker. The engine opens the PDF on its own worker.
async function poolReuse(pdfBase64: string, name: string): Promise<PoolReuseReport> {
  const pdf = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0)).buffer;
  const engineWorker = startEngine({
    workerUrl: '/src/engine/engine.worker.ts',
    assetBaseUrl: ASSET_BASE,
  });
  const engine = new RpcClient(engineWorker);
  const jobs = newPool();
  const files: number[] = [];
  try {
    const opened = await engine.call('session.open', { name, data: pdf, password: null });
    jobs.warm();
    for (let run = 0; run < 2; run += 1) {
      const found = await runSplit(
        { engine, progress: createJobProgressStore(), startWorker: jobs.acquire },
        opened.handle,
        { mode: 'pages', pagesPerFile: 1 },
        { name, zip: false },
      );
      files.push(found.length);
    }
    return { files };
  } catch (error) {
    return { files, error: describe(error) };
  }
  // The engine worker stays up: the test looks inside the job worker and tells it apart from the
  // engine by its fetch global, and a terminated worker cannot be read.
}

export interface PoolCancelReport {
  // The hello the re-warmed worker answered after the cancelled job.
  hello?: unknown;
  error?: { name: string; message: string; code?: string };
}

// A job is cancelled while its call is pending: the lease terminates the worker, the pool starts
// another in the background, and that worker answers hello.
async function poolCancel(): Promise<PoolCancelReport> {
  const jobs = newPool();
  jobs.warm();
  const lease = jobs.acquire();
  // The first worker answers before the cancel, so the browser has seen it in full.
  await lease.call(HELLO);
  // The second call is still pending when the lease terminates: that is a Cancel.
  const pending = lease.call(HELLO).catch(() => undefined);
  lease.terminate();
  await pending;
  try {
    // A raw call, not RpcClient: the re-warm may still be loading, and RpcClient's soft deadline
    // would report a slow start as a failure.
    const result = await jobs.acquire().call(HELLO);
    // The reply is the envelope { v, id, ok, result }; the hello answer is its result.
    return { hello: (JSON.parse(result.reply) as { result: unknown }).result };
  } catch (error) {
    return { error: describe(error) };
  }
}

function poolStop(): void {
  pool?.dispose();
  pool = undefined;
}

declare global {
  interface Window {
    __harness: {
      bootEngine: () => Promise<BootReport>;
      bootJob: () => Promise<BootReport>;
      stopJob: () => void;
      rawHello: (assetBaseUrl: string) => Promise<BootReport>;
      runSplitJob: (pdfBase64: string, name: string) => Promise<SplitReport>;
      poolReuse: (pdfBase64: string, name: string) => Promise<PoolReuseReport>;
      poolCancel: () => Promise<PoolCancelReport>;
      poolStop: () => void;
    };
  }
}

window.__harness = {
  bootEngine,
  bootJob,
  stopJob,
  rawHello,
  runSplitJob,
  poolReuse,
  poolCancel,
  poolStop,
};
