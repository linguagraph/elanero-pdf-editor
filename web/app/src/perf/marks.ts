// Load-stage marks for the W8.3 harness (docs/web/design/W8.3-performance.md, 2.1). Each mark is
// named `elanero:load:<stage>`, so the browser harness reads them with
// performance.getEntriesByType('mark') and can point a W2 regression at its stage. A mark never
// changes the load: a missing or failing Performance API is ignored.
import type { Stage } from '../engine/protocol';

// 'start' opens the load; the engine stages follow; 'open' is the document opened by session.open;
// 'paint' is the first page image drawn.
export type LoadStage = Stage | 'start' | 'open' | 'paint';

export function markLoadStage(stage: LoadStage): void {
  try {
    performance.mark(`elanero:load:${stage}`);
  } catch {
    // Some environments (for example older test runners) have no User Timing API.
  }
}
