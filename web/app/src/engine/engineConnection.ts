// The app's link to the engine worker (W3.1). It starts the engine, passes each stage event to the
// loading screen's store, and keeps the RPC client once the engine answers hello. Nothing else in
// the app starts a worker or calls the engine before then: client() is undefined until the engine
// is ready, and again after a failure.
import { useSyncExternalStore } from 'react';
import { engineLoad, type EngineLoadStore } from '../feedback/engineLoad';
import { type CallOptions, createRpcClient, type RpcClient } from '../rpc/client';
import { CallError, EngineLoadError } from './errors';
import type { FailedStage, Stage } from './protocol';
import { startEngine, type StartOptions, type WorkerClient } from './start';
import type { Methods } from '../rpc/generated';

// The calls the app makes on the engine. The real RPC client satisfies it; tests pass a fake.
export type EngineClient = Pick<RpcClient, 'call' | 'chunked'>;

// The first call waits for the whole load, so it gets no short deadline: a first visit can take
// minutes on a slow network (docs/web/plan.md, decision 10). This only stops a worker that never
// answers at all.
export const LOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface EngineConnection {
  // The stage store the loading screen reads.
  readonly store: EngineLoadStore;
  // The RPC client, once the engine is ready. Undefined before that and after a failure.
  client(): EngineClient | undefined;
  // Resolves with the RPC client once the engine is ready. A failed load does not reject it: the
  // wait goes on through a Try again. Rejects only on dispose(). The open queue uses it (W3.1).
  whenReady(): Promise<EngineClient>;
  // Starts the engine, or starts it again. Any worker already running is terminated first.
  start(): void;
  // Stops the worker. Called when the app unmounts.
  dispose(): void;
}

export interface EngineConnectionOptions {
  readonly boot: StartOptions;
  // Defaults to the shared store the loading screen reads.
  readonly store?: EngineLoadStore;
  // Defaults to startEngine. Tests pass a fake worker here.
  readonly startWorker?: (options: StartOptions) => WorkerClient;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The stage that failed is the last one the worker reported. A failure before any stage event
// (the worker script itself did not load) is counted as the first stage. 'ready' cannot fail, so
// a failure after it (a bad hello reply) is reported as the engine stage.
function failedStage(last: Stage | undefined): FailedStage {
  if (last === undefined) return 'pyodide';
  return last === 'ready' ? 'engine' : last;
}

export function createEngineConnection(options: EngineConnectionOptions): EngineConnection {
  const store = options.store ?? engineLoad;
  const startWorker = options.startWorker ?? startEngine;
  // Every start gets a number. A callback from an older worker sees a different number and does
  // nothing, so a terminated worker can never change the state.
  let generation = 0;
  let worker: WorkerClient | undefined;
  let rpc: EngineClient | undefined;
  // Callers waiting in whenReady(). They survive a failed load and a restart; only dispose()
  // rejects them.
  let waiters: { resolve(client: EngineClient): void; reject(error: Error): void }[] = [];

  const stop = (): void => {
    generation += 1;
    worker?.terminate();
    worker = undefined;
    rpc = undefined;
  };

  const start = (): void => {
    stop();
    // Registered on every start, not once: dispose() clears it, and a remount starts again.
    store.setStarter(start);
    const current = generation;
    const isCurrent = (): boolean => current === generation;
    store.stage('pyodide');

    let next: WorkerClient;
    try {
      next = startWorker(options.boot);
    } catch (error) {
      // The browser refused the worker (no Worker support, a blocked URL): a load failure.
      store.fail(new EngineLoadError('pyodide', messageOf(error), { cause: error }));
      return;
    }
    worker = next;

    let last: Stage | undefined;
    next.onStage((stage) => {
      if (!isCurrent()) return;
      last = stage;
      store.stage(stage);
    });

    // hello waits for the load and checks the protocol, so its answer is the readiness signal.
    const client = createRpcClient(next);
    client.call('hello', {}, { timeoutMs: LOAD_TIMEOUT_MS }).then(
      () => {
        if (!isCurrent()) return;
        rpc = client;
        const ready = waiters;
        waiters = [];
        for (const waiter of ready) waiter.resolve(client);
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        store.fail(new EngineLoadError(failedStage(last), messageOf(error), { cause: error }));
      },
    );
  };

  return {
    store,
    client: () => rpc,
    whenReady() {
      if (rpc !== undefined) return Promise.resolve(rpc);
      return new Promise<EngineClient>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    start,
    dispose() {
      stop();
      store.setStarter(undefined);
      const pending = waiters;
      waiters = [];
      for (const waiter of pending) {
        waiter.reject(new CallError('the engine connection was disposed'));
      }
    },
  };
}

// W5.1a: the per-tab engine session store.
// The engine session each open tab can show (W5.1a). A tab gets a session only when its document
// is open in the engine and the RPC client is connected (hello succeeded); until then the document
// view is not mounted for it. Nothing sets a session yet: the open wiring comes with the RPC
// session work, so this store is the seam that work fills in. The UI reads it, never the worker.
// The calls the document view, the thumbnails panel and the page organizer make. RpcClient satisfies
// this; tests pass a fake.
export interface PageRpc {
  call<
    M extends
      | 'session.pages'
      | 'session.info'
      | 'session.outline'
      | 'session.security'
      | 'session.unlock_owner'
      | 'render.page'
      | 'render.tile'
      | 'text.layer'
      | 'actions.run'
      | 'actions.undo'
      | 'jobs.prepare'
      | 'jobs.apply'
      | 'jobs.abort'
      | 'comments.flattenable'
      | 'comments.xfdf_preview'
      | 'marks.list',
  >(
    method: M,
    params: Methods[M]['params'],
  ): Promise<Methods[M]['result']>;
  // Each slice of a chunked call (text.search, W5.4), as RpcClient.chunked gives them.
  chunked<M extends 'text.search'>(
    method: M,
    params: Omit<Methods[M]['params'], 'cursor'>,
    options?: CallOptions,
  ): AsyncGenerator<Methods[M]['result'], void, undefined>;
}

export interface EngineSession {
  readonly rpc: PageRpc;
  // The document handle the engine gave at session.open; every call names it.
  readonly handle: string;
}

const sessions = new Map<number, EngineSession>();
const listeners = new Set<() => void>();

export function setTabSession(tabId: number, session: EngineSession | null): void {
  if (session === null) sessions.delete(tabId);
  else sessions.set(tabId, session);
  for (const listener of listeners) listener();
}

export function getTabSession(tabId: number): EngineSession | null {
  return sessions.get(tabId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The session of the given tab, or null when there is no tab or the tab has none.
export function useTabSession(tabId: number | null): EngineSession | null {
  return useSyncExternalStore(
    subscribe,
    () => (tabId === null ? null : getTabSession(tabId)),
    () => null,
  );
}
