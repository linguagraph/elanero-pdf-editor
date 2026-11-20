// The engine worker: one per browser tab, holding every open document (W1.1 section 1). Like the
// job worker, it loses its network globals once the engine is up (W8.6 F1), so a call that needs
// the network fails. Translation (W6.6) will add its own allow-listed wrapper.
import { loadEngine, type LoadEngine } from './loader';
import { lockDownGlobals } from './networkLock';
import { isWorkerContext, serveEngine, type WorkerScope } from './worker-server';

export function serveEngineWorker(scope: WorkerScope, load: LoadEngine = loadEngine): void {
  serveEngine(scope, {
    load,
    beforeEngine: () => lockDownGlobals(globalThis, 'engine worker'),
  });
}

if (isWorkerContext()) {
  serveEngineWorker(globalThis as unknown as WorkerScope);
}
