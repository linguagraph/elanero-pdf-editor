// The React binding of the redaction controller (W7.4): one controller per open document, read
// through useSyncExternalStore as the job bar reads its store. A new document (a new handle or
// session) gets a new controller, with no marks and the mark tool off.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ActionJobWorker } from '../actionJob/actionJob';
import type { PageRpc } from '../engine/engineConnection';
import type { RenderScheduler } from '../view/renderScheduler';
import { RedactionController, type RedactionSnapshot } from './controller';

export interface UseRedactionOptions {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'noteRevisions'>;
  // Stable for one document: a new function makes a new controller, and its marks start over.
  readonly startWorker: () => ActionJobWorker;
}

export function useRedaction(options: UseRedactionOptions): {
  readonly controller: RedactionController;
  readonly state: RedactionSnapshot;
} {
  const { rpc, handle, scheduler, startWorker } = options;
  const controller = useMemo(
    () => new RedactionController({ rpc, handle, scheduler, startWorker }),
    [rpc, handle, scheduler, startWorker],
  );
  useEffect(() => () => controller.setActive(false), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state };
}
