// The engine worker: one per browser tab, holding every open document (W1.1 section 1).
import { loadEngine } from './loader';
import { isWorkerContext, serveEngine, type WorkerScope } from './worker-server';

if (isWorkerContext()) {
  serveEngine(globalThis as unknown as WorkerScope, { load: loadEngine });
}
