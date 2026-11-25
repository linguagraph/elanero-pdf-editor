// Load-stage marks for the W8.3 harness (docs/web/design/W8.3-performance.md, 2.1). Each mark is
// named `elanero:load:<stage>`, so the browser harness reads them with
// performance.getEntriesByType('mark') and can point a W2 regression at its stage. A mark never
// changes the load: a missing or failing Performance API is ignored.
export function markLoadStage(stage: string): void {
  try {
    performance.mark(`elanero:load:${stage}`);
  } catch {
    // Some environments (for example older test runners) have no User Timing API.
  }
}
