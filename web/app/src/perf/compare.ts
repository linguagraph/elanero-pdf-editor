// Comparison rules for the W8.3 web perf numbers (docs/web/design/W8.3-performance.md, 2.2).
// Pure: no I/O, so the CLI (scripts/perf-compare.ts) and the tests share it. Runners vary by about
// 40%, so only the median (or the median of per-run maxima) is compared, and a paired metric is
// compared with the baseline commit run in the same job, never with a fixed number.

export type MetricKind = 'paired' | 'absolute' | 'trend' | 'ceiling' | 'hard';

// One row of tests/perf/budgets.json, as the comparison reads it.
export interface MetricRule {
  id: string;
  kind: MetricKind;
  // false = trend only: reported, never fails (the table's enforce flag).
  enforce: boolean;
  // absolute: the median of the samples must be at most limitMs.
  limitMs?: number;
  // paired: HEAD fails only when it is more than pct percent AND more than absMs slower.
  pct?: number;
  absMs?: number;
  // ceiling: HEAD fails above factor times baselineMs.
  factor?: number;
  baselineMs?: number | null;
}

// One record of a perf-results.json file: the samples are the per-run values.
export interface PerfRecord {
  id: string;
  samples: number[];
}

export interface RunResults {
  records: PerfRecord[];
}

// One attempt: the HEAD results and, for paired metrics, the baseline commit's results.
export interface AttemptInput {
  attempt: number;
  head: RunResults;
  baseline?: RunResults | null;
}

export type RowStatus = 'pass' | 'fail' | 'trend' | 'skipped';

export interface RowResult {
  id: string;
  kind: MetricKind;
  status: RowStatus;
  attempt: number;
  headMedian: number | null;
  baselineMedian: number | null;
  reason: string;
}

export interface AttemptReport {
  attempt: number;
  passed: boolean;
  rows: RowResult[];
}

export interface CompareReport {
  // True when at least one attempt passed: a result set that fails is rerun once, and the run
  // fails only if every attempt fails.
  passed: boolean;
  attempts: AttemptReport[];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function findRecord(run: RunResults | null | undefined, id: string): PerfRecord | undefined {
  return run?.records.find((record) => record.id === id);
}

// Gated rows are the ones that fail a run; trend rows (enforce false, or kind trend) never do.
function isGated(rule: MetricRule): boolean {
  return rule.enforce && rule.kind !== 'trend' && rule.kind !== 'hard';
}

function row(
  rule: MetricRule,
  attempt: number,
  status: RowStatus,
  headMedian: number | null,
  baselineMedian: number | null,
  reason: string,
): RowResult {
  return { id: rule.id, kind: rule.kind, status, attempt, headMedian, baselineMedian, reason };
}

function compareOne(
  rule: MetricRule,
  attempt: number,
  head: RunResults,
  baseline: RunResults | null | undefined,
): RowResult {
  const gated = isGated(rule);
  const headSamples = findRecord(head, rule.id)?.samples ?? [];
  // Fail closed before any median: sort() with a NaN (or a JSON null) misorders the samples, so a
  // single bad sample could leave a finite median and pass. Every sample must be a finite number.
  if (headSamples.length > 0 && !headSamples.every(Number.isFinite)) {
    return row(rule, attempt, gated ? 'fail' : 'trend', null, null, 'non-finite HEAD sample');
  }
  const headMedian = headSamples.length > 0 ? median(headSamples) : null;
  if (headMedian === null) {
    // A required metric missing from HEAD fails the run; a trend metric is only reported.
    return row(rule, attempt, gated ? 'fail' : 'trend', null, null, 'no HEAD samples');
  }
  if (rule.kind === 'trend' || !gated) {
    return row(rule, attempt, 'trend', headMedian, null, 'trend only, not gated');
  }

  if (rule.kind === 'absolute') {
    const limit = rule.limitMs ?? Number.NaN;
    const status = headMedian <= limit ? 'pass' : 'fail';
    return row(rule, attempt, status, headMedian, null, `median of samples vs limit ${limit} ms`);
  }

  if (rule.kind === 'ceiling') {
    const base = rule.baselineMs ?? null;
    // An enforced ceiling without baseline_ms is a configuration error (the table test forbids
    // it), so it fails loudly instead of passing as skipped.
    if (base === null) {
      return row(rule, attempt, 'fail', headMedian, null, 'enforced ceiling has no baseline_ms');
    }
    const ceiling = (rule.factor ?? Number.NaN) * base;
    const status = headMedian <= ceiling ? 'pass' : 'fail';
    return row(rule, attempt, status, headMedian, base, `ceiling ${ceiling}`);
  }

  if (rule.kind === 'paired') {
    // No baseline run (for example, its commit could not be built): skipped with a notice.
    if (baseline === null || baseline === undefined) {
      return row(rule, attempt, 'skipped', headMedian, null, 'no baseline run');
    }
    const baseSamples = findRecord(baseline, rule.id)?.samples ?? [];
    if (baseSamples.length === 0) {
      // The baseline run exists but has no record for this metric: a broken comparison, so fail.
      return row(rule, attempt, 'fail', headMedian, null, 'baseline run has no samples for it');
    }
    if (!baseSamples.every(Number.isFinite)) {
      return row(rule, attempt, 'fail', headMedian, null, 'non-finite baseline sample');
    }
    const baseMedian = median(baseSamples);
    const slower = headMedian - baseMedian;
    // Fail closed: a missing or NaN threshold or sample must not pass as "not over the limit".
    if (![headMedian, baseMedian, rule.pct, rule.absMs].every(Number.isFinite)) {
      return row(rule, attempt, 'fail', headMedian, baseMedian, 'paired values are not finite');
    }
    // Strictly more than both limits: exactly 15% or exactly 300 ms over is not a failure.
    // Written as a cross-multiplication so the 15% test has no float rounding at the boundary.
    const overPct = slower * 100 > (rule.pct as number) * baseMedian;
    const overAbs = slower > (rule.absMs as number);
    const status = overPct && overAbs ? 'fail' : 'pass';
    return row(rule, attempt, status, headMedian, baseMedian, `slower by ${slower} ms`);
  }

  return row(rule, attempt, 'trend', headMedian, null, `unknown kind ${rule.kind}`);
}

function compareAttempt(rules: readonly MetricRule[], input: AttemptInput): AttemptReport {
  const rows = rules.map((rule) => compareOne(rule, input.attempt, input.head, input.baseline));
  return { attempt: input.attempt, passed: rows.every((r) => r.status !== 'fail'), rows };
}

// Compares every attempt against the rules. The run passes when any attempt passes, so a single
// retry can rescue a noisy first attempt, but a real regression fails both attempts.
export function compareAttempts(
  rules: readonly MetricRule[],
  attempts: readonly AttemptInput[],
): CompareReport {
  const reports = attempts.map((attempt) => compareAttempt(rules, attempt));
  return { passed: reports.some((report) => report.passed), attempts: reports };
}
