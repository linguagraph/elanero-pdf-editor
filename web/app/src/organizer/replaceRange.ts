// The Replace pages dialog's page arithmetic (issue 772, R2). The typed range is 1-based and goes to
// pages.replace 0-based; an uncounted file's range is checked for form only (the action refuses it).
import type { MessageId } from '../i18n/en';
import { parsePageRanges } from '../pages/pageRanges';

// The largest page number an uncounted range may name, so the page list is never built from a huge span.
export const UNCHECKED_CAP = 1_000_000;

export type SourceRange =
  | { readonly pages: readonly number[] }
  | { readonly message: MessageId; readonly params: Readonly<Record<string, number>> };

// The desktop's default: 1 to min(count, selected).
export function defaultRange(count: number | null, selected: number): string {
  return count === null ? `1-${selected}` : `1-${Math.min(count, selected)}`;
}

// Without a count, every item needs both ends: "3-", "all" or a blank would mean "to the last page",
// which cannot be named here. The largest number stands in for the count to build the list.
export function sourceRange(text: string, count: number | null): SourceRange {
  if (count !== null) {
    const parsed = parsePageRanges(text, count);
    if (parsed.ok && parsed.pages !== null) return { pages: parsed.pages };
    return { message: 'replace.rangeProblem', params: { count } };
  }
  const spec = text.trim();
  const open = spec === '' || /^all$/i.test(spec) || /(^|[,;])\s*-|-\s*($|[,;])/.test(spec);
  const top = Math.max(1, ...(spec.match(/\d+/g) ?? []).map(Number));
  const parsed = open || top > UNCHECKED_CAP ? null : parsePageRanges(spec, top);
  if (parsed === null || !parsed.ok || parsed.pages === null) {
    return { message: 'replace.rangeUnknown', params: {} };
  }
  return { pages: parsed.pages };
}

// The selected pages as the dialog names them, 1-based, runs joined: "3-5, 8".
export function describePages(picked: readonly number[]): string {
  const sorted = [...new Set(picked)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) continue;
    const from = sorted[start]! + 1;
    const to = sorted[i]! + 1;
    runs.push(from === to ? `${from}` : `${from}–${to}`);
    start = i + 1;
  }
  return runs.join(', ');
}
