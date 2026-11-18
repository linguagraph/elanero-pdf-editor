// The waiting service worker and the update prompt's state (W4.6). A new version installs in the
// background and waits; it takes over only when the user accepts the prompt, so no page is
// reloaded under the user's work.

type Listener = () => void;

let waitingWorker: ServiceWorker | undefined;
const listeners = new Set<Listener>();

export function reportWaitingWorker(worker: ServiceWorker): void {
  waitingWorker = worker;
  for (const listener of listeners) listener();
}

export function getWaitingWorker(): ServiceWorker | undefined {
  return waitingWorker;
}

// For useSyncExternalStore: returns an unsubscribe function.
export function subscribeUpdates(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Lets the waiting worker take over and reloads once the new worker controls the page, so the
// page runs the new version's files. Reload is passed in so tests do not reload the page.
export function applyWaitingWorker(
  container: ServiceWorkerContainer | undefined,
  reload: () => void,
): void {
  const worker = waitingWorker;
  if (worker === undefined) return;
  container?.addEventListener('controllerchange', () => reload(), { once: true });
  worker.postMessage({ type: 'SKIP_WAITING' });
}

// Tests only: forgets any reported worker.
export function resetUpdateState(): void {
  waitingWorker = undefined;
}
