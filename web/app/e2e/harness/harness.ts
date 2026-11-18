// Test-only page script (W3.1): starts the engine and the job worker through the real start.ts,
// and reports what the browser test needs. The Playwright test reads window.__harness.
import { EngineLoadError } from '../../src/engine/errors';
import { startEngine, startJobWorker, type WorkerClient } from '../../src/engine/start';
import type { Stage } from '../../src/engine/protocol';
import { RpcClient } from '../../src/rpc/client';

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

declare global {
  interface Window {
    __harness: {
      bootEngine: () => Promise<BootReport>;
      bootJob: () => Promise<BootReport>;
      stopJob: () => void;
      rawHello: (assetBaseUrl: string) => Promise<BootReport>;
    };
  }
}

window.__harness = { bootEngine, bootJob, stopJob, rawHello };
