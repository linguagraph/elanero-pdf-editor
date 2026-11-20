// The React binding of the redaction controller (W7.4): one controller per open document, read
// through useSyncExternalStore as the job bar reads its store. The App makes one per session and
// passes it in (so the toolbar and the panel share it); without one, the view makes its own. A new
// document (a new handle or session) gets a new controller, with no marks and the mark tool off.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import type { RenderScheduler } from '../view/renderScheduler';
import { RedactionController, type RedactionSnapshot } from './controller';

export interface UseRedactionOptions {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions' | 'subscribeRevisions'>;
  // Stable for one document: a new function makes a new controller, and its marks start over.
  readonly startWorker: () => ActionJobWorker;
  // The document's controller, when the App made one for the session.
  readonly controller?: RedactionController;
}

export function useRedaction(options: UseRedactionOptions): {
  readonly controller: RedactionController;
  readonly state: RedactionSnapshot;
} {
  const { rpc, handle, scheduler, startWorker, controller: shared } = options;
  const own = useMemo(
    () => new RedactionController({ rpc, handle, scheduler, startWorker }),
    [rpc, handle, scheduler, startWorker],
  );
  const controller = shared ?? own;
  useEffect(() => {
    const stop = controller.start();
    return () => {
      stop();
      controller.setActive(false);
    };
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state };
}

// The state of a controller the caller only reads (the rail count, the panel). Null when there is
// no controller, which is when no document is open.
const NO_CONTROLLER_STATE: RedactionSnapshot = {
  active: false,
  marks: [],
  selected: [],
  busy: false,
  loaded: false,
};
const noSubscribe = (): (() => void) => () => {};
const noState = (): RedactionSnapshot => NO_CONTROLLER_STATE;

export function useRedactionState(
  controller: RedactionController | null | undefined,
): RedactionSnapshot | null {
  const state = useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.getSnapshot : noState,
  );
  return controller ? state : null;
}
