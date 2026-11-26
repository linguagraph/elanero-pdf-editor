// W8.3: compares the HEAD and baseline perf-results.json files and prints a markdown table.
//
//   node --experimental-strip-types scripts/perf-compare.ts <budgets.json> <head.json> <baseline.json> [<head.json> <baseline.json>]
//
// Each head/baseline pair is one attempt (the retry is a second pair). The baseline may be "-"
// when the baseline commit could not be built: paired rows are then skipped with a notice. Only
// the web rows (ids starting with W) are compared, so the desktop D rows are left out. Exit code 1
// when every attempt fails (src/perf/compare.ts); exit code 2 for a broken input (a missing or
// corrupt results file, or a bad argument list), which is not a perf regression.
import { readFile } from 'node:fs/promises';
import {
  compareAttempts,
  type AttemptInput,
  type MetricRule,
  type RunResults,
} from '../src/perf/compare.ts';

interface BudgetRow {
  id: string;
  kind: MetricRule['kind'];
  enforce: boolean;
  limit_ms?: number;
  pct?: number;
  abs_ms?: number;
  factor?: number;
  baseline_ms?: number | null;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function toRunResults(value: unknown, path: string): RunResults {
  const records = (value as { records?: unknown } | null)?.records;
  if (!Array.isArray(records)) throw new Error(`${path} has no records array`);
  return {
    records: records.map((record) => {
      const { id, samples } = record as { id: unknown; samples: unknown };
      if (typeof id !== 'string' || !Array.isArray(samples)) {
        throw new Error(`${path} has a record without an id or samples`);
      }
      return { id, samples: samples as number[] };
    }),
  };
}

function toRule(row: BudgetRow): MetricRule {
  return {
    id: row.id,
    kind: row.kind,
    enforce: row.enforce,
    limitMs: row.limit_ms,
    pct: row.pct,
    absMs: row.abs_ms,
    factor: row.factor,
    baselineMs: row.baseline_ms,
  };
}

async function main(): Promise<number> {
  const [budgetsPath, ...files] = process.argv.slice(2);
  if (budgetsPath === undefined || files.length === 0 || files.length % 2 !== 0) {
    console.error('usage: perf-compare.ts <budgets.json> <head.json> <baseline.json> [...]');
    return 2;
  }
  const budgets = (await readJson(budgetsPath)) as { metrics: BudgetRow[] };
  const rules = budgets.metrics
    .filter((row) => row.id.startsWith('W') && row.kind !== 'hard')
    .map(toRule);

  const attempts: AttemptInput[] = [];
  for (let index = 0; index < files.length; index += 2) {
    const headPath = files[index] as string;
    const basePath = files[index + 1] as string;
    const head = toRunResults(await readJson(headPath), headPath);
    const baseline = basePath === '-' ? null : toRunResults(await readJson(basePath), basePath);
    attempts.push({ attempt: index / 2 + 1, head, baseline });
  }

  const report = compareAttempts(rules, attempts);
  console.log('| Attempt | Metric | Kind | HEAD median | Baseline median | Status | Note |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const attempt of report.attempts) {
    for (const row of attempt.rows) {
      const cell = (value: number | null) => (value === null ? '-' : String(Math.round(value)));
      console.log(
        `| ${row.attempt} | ${row.id} | ${row.kind} | ${cell(row.headMedian)} | ${cell(row.baselineMedian)} | ${row.status} | ${row.reason} |`,
      );
    }
  }
  if (!report.passed) {
    console.error('::error::the web perf comparison failed on every attempt');
    return 1;
  }
  return 0;
}

// A thrown error (unreadable or corrupt input) is exit 2, so CI can tell it from a regression (1).
try {
  process.exitCode = await main();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
