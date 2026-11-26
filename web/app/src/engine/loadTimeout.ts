// The deadline for the engine's first hello. It lives in its own module with no imports, so the
// test harness (e2e/harness) can take it without pulling in engineConnection's module graph: that
// graph reaches the loading and not-responding dialogs, whose CSS the harness page's strict CSP
// (no inline style) would block.

// The first call waits for the whole load, so it gets no short deadline: a first visit can take
// minutes on a slow network (docs/web/plan.md, decision 10). This only stops a worker that never
// answers at all.
export const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
