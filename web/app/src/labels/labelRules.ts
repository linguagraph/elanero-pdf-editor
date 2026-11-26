// Page label rules for the Page labels dialog (Organize, slice 1). A rule starts at a 0-based page
// and lasts until the next one; the rows show the page one-based, as the desktop does.
import type { PageLabelRuleDto } from '../rpc/generated';

// The numbering styles as the engine names them (model/pages.py LabelStyle); '' is prefix only.
export type LabelStyleCode = 'D' | 'R' | 'r' | 'A' | 'a' | '';
export const LABEL_STYLE_CODES: readonly LabelStyleCode[] = ['D', 'r', 'R', 'a', 'A', ''];

// A row as the dialog holds it: the text the user typed.
export interface LabelRow {
  readonly from: string;
  readonly style: LabelStyleCode;
  readonly prefix: string;
  readonly first: string;
}

// A rule as `pages.set_labels` takes it.
export interface LabelRule {
  readonly start: number;
  readonly style: LabelStyleCode;
  readonly prefix: string;
  readonly first: number;
}

export type LabelCheck =
  | { readonly ok: true; readonly rules: readonly LabelRule[] }
  | { readonly ok: false; readonly problem: 'fromPage' | 'startAt'; readonly row: number };

export function newLabelRow(): LabelRow {
  return { from: '1', style: 'D', prefix: '', first: '1' };
}

// The rows that show saved rules. An unknown style shows as decimal.
export function rowsFromRules(rules: readonly PageLabelRuleDto[]): LabelRow[] {
  return rules.map((rule) => ({
    from: String(rule.start + 1),
    style: (LABEL_STYLE_CODES as readonly string[]).includes(rule.style)
      ? (rule.style as LabelStyleCode)
      : 'D',
    prefix: rule.prefix,
    first: String(rule.first),
  }));
}

// Checks the rows and turns them into rules in page order. Rows with the same From page merge,
// and the later row wins, as on the desktop.
export function checkLabelRows(rows: readonly LabelRow[], pageCount: number): LabelCheck {
  const byStart = new Map<number, LabelRule>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const page = wholeNumber(row.from);
    if (page === null || page < 1 || page > pageCount) {
      return { ok: false, problem: 'fromPage', row: index };
    }
    const first = wholeNumber(row.first);
    if (first === null || first < 1) return { ok: false, problem: 'startAt', row: index };
    byStart.set(page - 1, { start: page - 1, style: row.style, prefix: row.prefix, first });
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b);
  return { ok: true, rules: starts.map((start) => byStart.get(start)!) };
}

function wholeNumber(text: string): number | null {
  const trimmed = text.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isSafeInteger(value) ? value : null;
}
