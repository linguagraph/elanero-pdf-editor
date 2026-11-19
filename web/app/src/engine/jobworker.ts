// The job worker: the same bootstrap, with the network globals removed before any engine code
// runs (W1.1 section 10). It holds no documents; jobs (W3.7) get a copy of the bytes per job.
import { loadEngine, type LoadEngine } from './loader';
import { isWorkerContext, serveEngine, type WorkerScope } from './worker-server';

export const FORBIDDEN_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts'] as const;

// Makes the network globals undefined. It fails closed: if one is still there afterwards, the
// load fails rather than running PDF code with network access.
export function lockDownGlobals(target: object = globalThis): void {
  const host = target as Record<string, unknown>;
  for (const name of FORBIDDEN_GLOBALS) {
    try {
      Object.defineProperty(host, name, {
        value: undefined,
        writable: false,
        configurable: true,
        enumerable: false,
      });
    } catch {
      // Not configurable: the check below decides.
    }
  }
  const remaining = FORBIDDEN_GLOBALS.filter((name) => host[name] !== undefined);
  if (remaining.length > 0) {
    throw new Error(`the job worker could not remove ${remaining.join(', ')}`);
  }
}

export function serveJobWorker(scope: WorkerScope, load: LoadEngine = loadEngine): void {
  serveEngine(scope, { load, beforeEngine: () => lockDownGlobals(), role: 'job' });
}

if (isWorkerContext()) {
  serveJobWorker(globalThis as unknown as WorkerScope);
}
