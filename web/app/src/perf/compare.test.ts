import { describe, expect, it } from 'vitest';
import {
  compareAttempts,
  median,
  type AttemptInput,
  type MetricRule,
  type RunResults,
} from './compare';

const paired: MetricRule = { id: 'W2', kind: 'paired', enforce: true, pct: 15, absMs: 300 };
const absolute: MetricRule = { id: 'W7', kind: 'absolute', enforce: true, limitMs: 50 };
const ceiling: MetricRule = {
  id: 'W9',
  kind: 'ceiling',
  enforce: true,
  factor: 1.25,
  baselineMs: 100,
};
const trend: MetricRule = { id: 'W3', kind: 'trend', enforce: false };

function run(id: string, samples: number[]): RunResults {
  return { records: [{ id, samples }] };
}

function one(rule: MetricRule, head: number[], base?: number[]) {
  const input: AttemptInput = {
    attempt: 1,
    head: run(rule.id, head),
    baseline: base === undefined ? null : run(rule.id, base),
  };
  const report = compareAttempts([rule], [input]);
  return report.attempts[0]?.rows[0];
}

describe('median', () => {
  it('takes the middle value of an odd count', () => {
    expect(median([9, 1, 5])).toBe(5);
  });

  it('averages the two middle values of an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('paired rule (W2)', () => {
  it('passes exactly at 15% and 300 ms over (the boundary is not a failure)', () => {
    // 2300 vs 2000: exactly 15% and exactly 300 ms slower.
    expect(one(paired, [2300], [2000])?.status).toBe('pass');
  });

  it('fails just past the boundary (15.05% and 301 ms)', () => {
    expect(one(paired, [2301], [2000])?.status).toBe('fail');
  });

  it('passes at 16% when only 200 ms slower', () => {
    // 200 ms over 1200 ms is 16.7%, but 200 ms is under 300 ms.
    expect(one(paired, [1400], [1200])?.status).toBe('pass');
  });

  it('passes at 400 ms over when only 10% slower', () => {
    // 4400 vs 4000: 400 ms over, but 10% is under 15%.
    expect(one(paired, [4400], [4000])?.status).toBe('pass');
  });

  it('fails when both 15% and 300 ms are exceeded', () => {
    expect(one(paired, [3000], [2000])?.status).toBe('fail');
  });

  it('is skipped, not failed, when there is no baseline run', () => {
    expect(one(paired, [3000])?.status).toBe('skipped');
  });
});

describe('absolute rule (W7): median of per-run maxima', () => {
  it('uses the median of the per-run maxima, so one slow run does not fail', () => {
    // Maxima 20, 45, 200 ms: the median 45 is under 50 even though one run hit 200 ms.
    expect(one(absolute, [20, 45, 200])?.status).toBe('pass');
  });

  it('fails when the median of maxima is over the limit', () => {
    expect(one(absolute, [10, 60, 70])?.status).toBe('fail');
  });

  it('uses the mean of the two middle maxima for an even count', () => {
    // Median of 40, 48, 52, 90 is (48 + 52) / 2 = 50, which is at the limit: a pass.
    expect(one(absolute, [40, 48, 52, 90])?.status).toBe('pass');
    expect(one(absolute, [40, 52, 53, 90])?.status).toBe('fail');
  });
});

describe('ceiling rule', () => {
  it('passes at exactly factor times the baseline', () => {
    expect(one(ceiling, [125])?.status).toBe('pass');
  });

  it('fails above factor times the baseline', () => {
    expect(one(ceiling, [126])?.status).toBe('fail');
  });
});

describe('trend rule (W3, W8)', () => {
  it('reports a large change without failing', () => {
    expect(one(trend, [999999], [1])?.status).toBe('trend');
  });
});

describe('required metrics', () => {
  it('fails when a gated metric is missing from HEAD results', () => {
    const report = compareAttempts([absolute], [{ attempt: 1, head: { records: [] } }]);
    expect(report.passed).toBe(false);
    expect(report.attempts[0]?.rows[0]?.status).toBe('fail');
  });

  it('does not fail for a missing trend metric', () => {
    const report = compareAttempts([trend], [{ attempt: 1, head: { records: [] } }]);
    expect(report.passed).toBe(true);
  });
});

describe('retry', () => {
  const failing: RunResults = run('W7', [80]);
  const passing: RunResults = run('W7', [20]);

  it('passes when the first attempt fails and the second passes, recording both attempts', () => {
    const report = compareAttempts(
      [absolute],
      [
        { attempt: 1, head: failing },
        { attempt: 2, head: passing },
      ],
    );
    expect(report.passed).toBe(true);
    expect(report.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(report.attempts[0]?.rows[0]?.attempt).toBe(1);
    expect(report.attempts[1]?.rows[0]?.attempt).toBe(2);
  });

  it('fails when both attempts fail', () => {
    const report = compareAttempts(
      [absolute],
      [
        { attempt: 1, head: failing },
        { attempt: 2, head: failing },
      ],
    );
    expect(report.passed).toBe(false);
  });

  it('fails with no attempts at all', () => {
    expect(compareAttempts([absolute], []).passed).toBe(false);
  });
});
