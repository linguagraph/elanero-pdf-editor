import { describe, expect, it } from 'vitest';
import type { PageLabelRuleDto } from '../rpc/generated';
import { checkLabelRows, newLabelRow, rowsFromRules, type LabelRow } from './labelRules';

const row = (from: string, style: LabelRow['style'] = 'D', prefix = '', first = '1'): LabelRow => ({
  from,
  style,
  prefix,
  first,
});

const dto = (start: number, style: string, prefix = '', first = 1): PageLabelRuleDto => ({
  start,
  style,
  prefix,
  first,
});

describe('checkLabelRows', () => {
  it('converts rows to 0-based rules in page order', () => {
    const result = checkLabelRows([row('3', 'A', 'Sec-', '2'), row('1', 'r')], 5);
    expect(result).toEqual({
      ok: true,
      rules: [
        { start: 0, style: 'r', prefix: '', first: 1 },
        { start: 2, style: 'A', prefix: 'Sec-', first: 2 },
      ],
    });
  });

  it('keeps a prefix-only rule as the empty style', () => {
    const result = checkLabelRows([row('2', '', 'Cover')], 3);
    expect(result).toEqual({
      ok: true,
      rules: [{ start: 1, style: '', prefix: 'Cover', first: 1 }],
    });
  });

  it.each(['0', '6', '', 'x', '1.5', '-1'])(
    'refuses a From page of %j in a 5-page document',
    (from) => {
      expect(checkLabelRows([row(from)], 5)).toEqual({ ok: false, problem: 'fromPage', row: 0 });
    },
  );

  it.each(['0', '', 'x', '2.5'])('refuses a Start at of %j', (first) => {
    expect(checkLabelRows([row('1', 'D', '', first)], 5)).toEqual({
      ok: false,
      problem: 'startAt',
      row: 0,
    });
  });

  it('points at the first bad row', () => {
    expect(checkLabelRows([row('1'), row('2'), row('9')], 5)).toEqual({
      ok: false,
      problem: 'fromPage',
      row: 2,
    });
  });

  it('merges rows with the same start, and the later row wins as on the desktop', () => {
    const result = checkLabelRows([row('2', 'D', 'Old-'), row('1', 'r'), row('2', 'A', 'New-')], 4);
    expect(result).toEqual({
      ok: true,
      rules: [
        { start: 0, style: 'r', prefix: '', first: 1 },
        { start: 1, style: 'A', prefix: 'New-', first: 1 },
      ],
    });
  });

  it('accepts no rows, which removes every label', () => {
    expect(checkLabelRows([], 5)).toEqual({ ok: true, rules: [] });
  });
});

describe('rowsFromRules', () => {
  it('shows each saved rule with a one-based From page', () => {
    expect(rowsFromRules([dto(0, 'r'), dto(2, 'D', 'A-', 1), dto(6, 'A', '', 26)])).toEqual([
      row('1', 'r'),
      row('3', 'D', 'A-', '1'),
      row('7', 'A', '', '26'),
    ]);
  });

  it('round-trips through checkLabelRows to the same rules', () => {
    const rules = [dto(0, 'r'), dto(2, 'D', 'A-', 1), dto(5, '', 'Cover', 1)];
    const result = checkLabelRows(rowsFromRules(rules), 8);
    expect(result).toEqual({
      ok: true,
      rules: rules.map(({ start, style, prefix, first }) => ({ start, style, prefix, first })),
    });
  });

  it('gives an unknown style the decimal default rather than a blank', () => {
    expect(rowsFromRules([dto(0, 'Z')])[0]?.style).toBe('D');
  });
});

describe('newLabelRow', () => {
  it('starts at page 1 with decimal numbers', () => {
    expect(newLabelRow()).toEqual(row('1', 'D', '', '1'));
  });
});
