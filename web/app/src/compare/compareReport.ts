// What the comparison report shows and saves (W7.8). The changes are grouped by the page they are
// on: a changed page lists its changes in the order the job gave them. The saved text is the same
// report, as plain text, so the two never disagree.
import { t } from '../i18n/t';
import type { MessageId } from '../i18n/en';
import type { CompareChange, CompareReport } from './compareJob';

// One changed page. pageA is the page in the open (older) document; it is null for a page that is
// only in the newer one, which has nothing to link to in the open view.
export interface ChangedPage {
  readonly pageA: number | null;
  readonly pageB: number | null;
  readonly changes: readonly CompareChange[];
}

// The change kinds of services/compare.py ChangeKind, as their message ids.
const KIND_LABELS: Readonly<Record<string, MessageId>> = {
  inserted: 'compare.kind.inserted',
  deleted: 'compare.kind.deleted',
  replaced: 'compare.kind.replaced',
  visual: 'compare.kind.visual',
  'page inserted': 'compare.kind.pageInserted',
  'page deleted': 'compare.kind.pageDeleted',
};

// The name of a change kind for the reader. A kind the page does not know yet is shown as the
// job names it, so a new kind is never hidden.
export function kindLabel(kind: string): string {
  const id = KIND_LABELS[kind];
  return id === undefined ? kind : t(id);
}

// The changed pages, in the order the job lists their changes. A page is keyed by its page in the
// open document, or by its page in the newer one when it has none there.
export function groupChanges(changes: readonly CompareChange[]): ChangedPage[] {
  const pages = new Map<
    string,
    { pageA: number | null; pageB: number | null; changes: CompareChange[] }
  >();
  for (const change of changes) {
    const key = change.pageA !== null ? `a${change.pageA}` : `b${change.pageB ?? -1}`;
    let page = pages.get(key);
    if (page === undefined) {
      page = { pageA: change.pageA, pageB: change.pageB, changes: [] };
      pages.set(key, page);
    }
    page.changes.push(change);
  }
  return [...pages.values()];
}

// The page count the report states: the aligned pairs, so a page added or removed counts once.
export function comparedPageCount(report: CompareReport): number {
  return report.pairs.length;
}

// The report as plain text, for the saved file. The names are the two documents' file names.
export function reportText(report: CompareReport, older: string, newer: string): string {
  const lines: string[] = [
    t('compare.report.title'),
    t('compare.report.older', { name: older }),
    t('compare.report.newer', { name: newer }),
    '',
    t('compare.report.summary', {
      compared: comparedPageCount(report),
      changed: groupChanges(report.changes).length,
    }),
  ];
  if (report.identical || report.changes.length === 0) {
    lines.push(t('compare.report.identical'));
    return `${lines.join('\n')}\n`;
  }
  for (const page of groupChanges(report.changes)) {
    lines.push('');
    lines.push(
      page.pageA !== null
        ? t('compare.report.page', { page: page.pageA + 1 })
        : t('compare.report.pageNewOnly', { page: (page.pageB ?? 0) + 1 }),
    );
    for (const change of page.changes) {
      lines.push(
        `  ${t('compare.report.change', { kind: kindLabel(change.kind), summary: change.summary })}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
