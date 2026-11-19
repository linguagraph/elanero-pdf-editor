import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineLoadStore, type LoadState } from '../feedback/engineLoad';
import type { CallResult } from './loader';
import {
  createEngineConnection,
  type EngineSession,
  getTabSession,
  setTabSession,
} from './engineConnection';
import type { Stage } from './protocol';
import type { StartOptions, WorkerClient } from './start';

interface PendingCall {
  readonly request: string;
  resolve(result: CallResult): void;
  reject(error: Error): void;
}

// A worker stand-in: the test emits stage events and answers or fails each call.
class FakeWorker implements WorkerClient {
  private listener: ((stage: Stage) => void) | undefined;
  readonly pending: PendingCall[] = [];
  readonly terminate = vi.fn<() => void>();

  call(request: string): Promise<CallResult> {
    return new Promise<CallResult>((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
    });
  }

  onStage(listener: (stage: Stage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  stage(stage: Stage): void {
    this.listener?.(stage);
  }

  // Answers the hello call the way the loaded engine does.
  answerHello(): void {
    const call = this.pending.shift();
    if (call === undefined) throw new Error('no call to answer');
    const id = (JSON.parse(call.request) as { id: number }).id;
    const reply = {
      v: 1,
      id,
      ok: true,
      result: { protocol: 1, engine: 'test', platform: 'web' },
      events: [],
    };
    call.resolve({ reply: JSON.stringify(reply) });
  }
}

const BOOT: StartOptions = {
  workerUrl: 'https://app.example/engine.js',
  assetBaseUrl: 'https://app.example/engine-assets/',
};

// Lets the promise chain of a settled call run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('engine connection', () => {
  let workers: FakeWorker[];
  let startWorker: ReturnType<typeof vi.fn<(options: StartOptions) => WorkerClient>>;

  beforeEach(() => {
    workers = [];
    startWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the engine with the boot options and passes each stage to the loading store', async () => {
    const store = createEngineLoadStore();
    const states: LoadState[] = [];
    store.subscribe(() => states.push(store.getState()));
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });

    engine.start();
    expect(startWorker).toHaveBeenCalledWith(BOOT);
    const worker = workers[0]!;
    worker.stage('packages');
    worker.stage('engine');
    worker.stage('ready');
    worker.answerHello();
    await settle();

    expect(states).toEqual([
      { status: 'loading', stage: 'pyodide' },
      { status: 'loading', stage: 'packages' },
      { status: 'loading', stage: 'engine' },
      { status: 'ready' },
    ]);
    expect(engine.client()).toBeDefined();
  });

  it('has no client until the engine answers hello, and sends hello first', () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    workers[0]!.stage('pyodide');
    expect(engine.client()).toBeUndefined();
    expect(workers[0]!.pending).toHaveLength(1);
    expect(workers[0]!.pending[0]!.request).toContain('"method":"hello"');
  });

  it('shows the stage that failed and gives no client', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    workers[0]!.stage('pyodide');
    workers[0]!.stage('packages');
    workers[0]!.pending[0]!.reject(new Error('wheel blocked'));
    await settle();

    expect(store.getState()).toEqual({ status: 'failed', stage: 'packages' });
    expect(engine.client()).toBeUndefined();
  });

  it('counts a failure before any stage event as the first stage', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    workers[0]!.pending[0]!.reject(new Error('the worker script did not load'));
    await settle();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });
    expect(engine.client()).toBeUndefined();
  });

  it('reports a worker the browser refuses to start as a pyodide failure', () => {
    const store = createEngineLoadStore();
    const refused = vi.fn((): WorkerClient => {
      throw new Error('Worker is not defined');
    });
    const engine = createEngineConnection({ boot: BOOT, store, startWorker: refused });
    engine.start();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });
    expect(engine.client()).toBeUndefined();
  });

  it('retry starts the engine again and terminates the failed worker', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    workers[0]!.stage('pyodide');
    workers[0]!.pending[0]!.reject(new Error('down'));
    await settle();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });

    store.retry();
    expect(startWorker).toHaveBeenCalledTimes(2);
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ status: 'loading', stage: 'pyodide' });

    workers[1]!.stage('ready');
    workers[1]!.answerHello();
    await settle();
    expect(store.getState()).toEqual({ status: 'ready' });
    expect(engine.client()).toBeDefined();
  });

  it('ignores events from a worker that a restart has replaced', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    const old = workers[0]!;
    engine.start();
    old.stage('ready');
    old.pending[0]?.reject(new Error('late failure'));
    await settle();
    expect(store.getState()).toEqual({ status: 'loading', stage: 'pyodide' });
    expect(engine.client()).toBeUndefined();
  });

  it('lets retry work again after a dispose and a new start (StrictMode remount)', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    engine.dispose();
    engine.start();
    workers[1]!.pending[0]!.reject(new Error('down'));
    await settle();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });
    store.retry();
    expect(startWorker).toHaveBeenCalledTimes(3);
  });

  it('stops the worker on dispose, and retry then does nothing', () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    engine.dispose();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    expect(engine.client()).toBeUndefined();
    store.retry();
    expect(startWorker).toHaveBeenCalledTimes(1);
  });
});

describe('whenReady', () => {
  let workers: FakeWorker[];
  let startWorker: ReturnType<typeof vi.fn<(options: StartOptions) => WorkerClient>>;

  beforeEach(() => {
    workers = [];
    startWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  it('resolves with the client once hello succeeds', async () => {
    const engine = createEngineConnection({
      boot: BOOT,
      store: createEngineLoadStore(),
      startWorker,
    });
    engine.start();
    let ready: unknown;
    void engine.whenReady().then((client) => {
      ready = client;
    });
    await settle();
    expect(ready).toBeUndefined();

    workers[0]!.answerHello();
    await settle();
    expect(ready).toBe(engine.client());
    expect(ready).toBeDefined();
  });

  it('resolves at once when the engine is already ready', async () => {
    const engine = createEngineConnection({
      boot: BOOT,
      store: createEngineLoadStore(),
      startWorker,
    });
    engine.start();
    workers[0]!.answerHello();
    await settle();
    await expect(engine.whenReady()).resolves.toBe(engine.client());
  });

  it('stays pending through a failed load, then resolves after a retry', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    const ready = vi.fn();
    void engine.whenReady().then(ready);
    workers[0]!.pending[0]!.reject(new Error('down'));
    await settle();
    expect(store.getState()).toEqual({ status: 'failed', stage: 'pyodide' });
    expect(ready).not.toHaveBeenCalled();

    store.retry();
    workers[1]!.answerHello();
    await settle();
    expect(ready).toHaveBeenCalledWith(engine.client());
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('rejects on dispose, with the connection-disposed error', async () => {
    const engine = createEngineConnection({
      boot: BOOT,
      store: createEngineLoadStore(),
      startWorker,
    });
    engine.start();
    const waiting = engine.whenReady();
    engine.dispose();
    await expect(waiting).rejects.toThrow('the engine connection was disposed');
  });

  it('never resolves with the client of a worker a restart has replaced', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker });
    engine.start();
    const ready = vi.fn();
    void engine.whenReady().then(ready);
    const old = workers[0]!;
    engine.start();
    old.answerHello();
    await settle();
    expect(ready).not.toHaveBeenCalled();
    expect(engine.client()).toBeUndefined();

    workers[1]!.answerHello();
    await settle();
    expect(ready).toHaveBeenCalledWith(engine.client());
  });
});

const session: EngineSession = {
  rpc: { call: () => Promise.reject(new Error('not used')) } as unknown as EngineSession['rpc'],
  handle: 'doc-1',
};

describe('tab engine sessions', () => {
  it('gives no session to a tab until one is set', () => {
    expect(getTabSession(101)).toBeNull();
  });

  it('keeps the session per tab and forgets it when cleared', () => {
    setTabSession(101, session);
    expect(getTabSession(101)).toBe(session);
    expect(getTabSession(102)).toBeNull();
    setTabSession(101, null);
    expect(getTabSession(101)).toBeNull();
  });
});

describe('engine restart and reporting (W3.9)', () => {
  let workers: FakeWorker[];
  let startWorker: ReturnType<typeof vi.fn<(options: StartOptions) => WorkerClient>>;

  beforeEach(() => {
    workers = [];
    startWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
  });

  async function readyEngine(report = vi.fn()) {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker, report });
    engine.start();
    workers[0]!.answerHello();
    await settle();
    return { engine, store, report };
  }

  it('replaces the worker: the old one is terminated, the new one must answer hello', async () => {
    const { engine } = await readyEngine();
    const old = workers[0]!;

    expect(engine.restart()).toBe(true);

    expect(startWorker).toHaveBeenCalledTimes(2);
    expect(old.terminate).toHaveBeenCalledTimes(1);
    expect(engine.client()).toBeUndefined();
    const ready = vi.fn();
    void engine.whenReady().then(ready);
    await settle();
    expect(ready).not.toHaveBeenCalled();

    workers[1]!.answerHello();
    await settle();
    expect(ready).toHaveBeenCalledWith(engine.client());
  });

  it('keeps the old engine running when the browser refuses the new worker', async () => {
    const { engine } = await readyEngine();
    const client = engine.client();
    startWorker.mockImplementationOnce(() => {
      throw new Error('Workers are blocked by this page');
    });

    expect(engine.restart()).toBe(false);

    expect(workers[0]!.terminate).not.toHaveBeenCalled();
    expect(engine.client()).toBe(client);
  });

  it('ignores a late failure of the old worker after a restart', async () => {
    const store = createEngineLoadStore();
    const engine = createEngineConnection({ boot: BOOT, store, startWorker, report: vi.fn() });
    engine.start();
    // The old engine is still loading (its hello is pending) when the restart replaces it.
    expect(workers[0]!.pending).toHaveLength(1);
    engine.restart();
    // Terminating the old worker rejects its pending hello: that is not a failure of the new one.
    workers[0]!.pending[0]!.reject(new Error('the worker has been terminated'));
    await settle();
    expect(store.getState()).toEqual({ status: 'loading', stage: 'pyodide' });

    workers[1]!.stage('ready');
    workers[1]!.answerHello();
    await settle();
    expect(store.getState()).toEqual({ status: 'ready' });
  });

  it('reports an out-of-memory call to the report hook and still rejects it', async () => {
    const { engine, report } = await readyEngine();
    const pending = engine.client()!.call('system.memory', {});
    workers[0]!.pending[0]!.reject(new Error('Cannot enlarge memory arrays'));

    await expect(pending).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' });
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'OUT_OF_MEMORY' }));
  });
});
