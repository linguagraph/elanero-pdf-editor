// The engine worker: one per browser tab, holding every open document (W1.1 section 1). Like the
// job worker, it loses its network globals once the engine is up (W8.6 F1), so a call that needs
// the network fails. The one exception is translation (W6.6): its constructor is kept here, before
// the lockdown, and reaches Python only through the gate in translationNet.ts.
import { loadEngine, type LoadEngine } from './loader';
import { lockDownGlobals } from './networkLock';
import { createTranslationNet, type XhrConstructor } from './translationNet';
import { isWorkerContext, serveEngine, type WorkerScope } from './worker-server';

export function serveEngineWorker(scope: WorkerScope, load: LoadEngine = loadEngine): void {
  const native = globalThis.XMLHttpRequest as unknown as XhrConstructor | undefined;
  serveEngine(scope, {
    load,
    beforeEngine: () => lockDownGlobals(globalThis, 'engine worker'),
    translation: createTranslationNet(native),
  });
}

if (isWorkerContext()) {
  serveEngineWorker(globalThis as unknown as WorkerScope);
}
