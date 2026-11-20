// The job worker: the same bootstrap, with the network globals removed before any engine code
// runs (W1.1 section 10). It holds no documents; jobs (W3.7) get a copy of the bytes per job.
import { loadEngine, type LoadEngine } from './loader';
import { lockDownGlobals } from './networkLock';
import { isWorkerContext, serveEngine, type WorkerScope } from './worker-server';

export { FORBIDDEN_GLOBALS, lockDownGlobals } from './networkLock';

export function serveJobWorker(scope: WorkerScope, load: LoadEngine = loadEngine): void {
  serveEngine(scope, {
    load,
    beforeEngine: () => lockDownGlobals(globalThis, 'job worker'),
    role: 'job',
  });
}

if (isWorkerContext()) {
  serveJobWorker(globalThis as unknown as WorkerScope);
}
