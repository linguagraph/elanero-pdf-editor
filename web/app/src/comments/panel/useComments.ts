// The React binding of the comments controller (W7.1b S2): one controller per open document, read
// through useSyncExternalStore as the redaction controller is. The App makes one per document and
// passes it in, so the panel, the rail badge and the commands share it; without one, the view makes
// its own. A new document (a new handle) gets a new controller, with the default filter.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PageRpc } from '../../engine/engineConnection';
import type { RenderScheduler } from '../../view/renderScheduler';
import { CommentsController, type CommentsSnapshot } from './controller';

export interface UseCommentsOptions {
  readonly rpc: PageRpc;
  readonly handle: string;
  readonly scheduler: Pick<RenderScheduler, 'subscribeRevisions'>;
  // The document's controller, when the App made one for the session.
  readonly controller?: CommentsController;
}

export function useComments(options: UseCommentsOptions): {
  readonly controller: CommentsController;
  readonly state: CommentsSnapshot;
} {
  const { rpc, handle, scheduler, controller: shared } = options;
  const own = useMemo(
    () => new CommentsController({ rpc, handle, scheduler }),
    [rpc, handle, scheduler],
  );
  const controller = shared ?? own;
  useEffect(() => controller.start(), [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, state };
}
